import * as github from '@actions/github'
import * as core from '@actions/core'
import Octokit from '@octokit/rest'
import * as treemap from 'jstreemap'

function createRunsQuery(
  octokit: github.GitHub,
  owner: string,
  repo: string,
  workflowId: string,
  status: string,
  branch: string
): Octokit.RequestOptions {
  const request = {
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    workflow_id: workflowId,
    status,
    branch
  }

  return octokit.actions.listWorkflowRuns.endpoint.merge(request)
}

async function cancelDuplicates(
  token: string,
  selfRunId: string,
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  const octokit = new github.GitHub(token)

  // Determine the workflow to reduce the result set, or reference another workflow
  const reply = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    // eslint-disable-next-line @typescript-eslint/camelcase
    run_id: Number.parseInt(selfRunId)
  })

  const workflowId = reply.data.workflow_url.split('/').pop() || ''
  if (workflowId === undefined || workflowId.length === 0) {
    throw new Error('Could not resolve workflow')
  }

  core.info(`Workflow ID is: ${workflowId}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sorted = new treemap.TreeMap<number, any>()
  for (const status of ['queued', 'in_progress']) {
    const listRuns = createRunsQuery(
      octokit,
      owner,
      repo,
      workflowId,
      status,
      branch
    )
    for await (const item of octokit.paginate.iterator(listRuns)) {
      // There is some sort of bug where the pagination URLs point to a
      // different endpoint URL which trips up the resulting representation
      // In that case, fallback to the actual REST 'workflow_runs' property
      const elements =
        item.data.length === undefined ? item.data.workflow_runs : item.data

      for (const element of elements) {
        sorted.set(element.run_number, element)
      }
    }
  }

  core.info(`Found queued/in_progress workflows: ${sorted.size}`)

  // If a workflow was provided process everything
  for (const entry of sorted.backward()) {
    const element = entry[1]

    const runId = element.id.toString()
    const event = element.event.toString()

    core.info(
      `Processing run ID: ${runId} [${event} : ${element.workflow_url} : ${element.status} : ${element.run_number}]`
    )

    if (runId >= selfRunId) {
      core.info(`Skipping larger run ID: ${runId}`)
      continue
    }

    if ('completed' === element.status.toString()) {
      core.info(`Skipping completed run ID: ${runId}`)
      continue
    }

    if (!['push', 'pull_request'].includes(event)) {
      core.info(`Skipping completed or non-event matching run ID: ${runId}`)
      continue
    }

    core.info(`Cancelling run ID: ${runId}`)

    await cancelRun(octokit, owner, repo, element.id)
  }
}

async function cancelRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  owner: string,
  repo: string,
  id: string
): Promise<void> {
  let reply
  try {
    reply = await octokit.actions.cancelWorkflowRun({
      owner,
      repo,
      // eslint-disable-next-line @typescript-eslint/camelcase
      run_id: id
    })
    core.info(`Previous run (id ${id}) cancelled, status = ${reply.status}`)
  } catch (error) {
    core.warning(
      `Could not cancel run (id ${id}): [${error.status}] ${error.message}`
    )
  }
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token')

    core.info(token)

    const selfRunId = getRequiredEnv('GITHUB_RUN_ID')
    const repository = getRequiredEnv('GITHUB_REPOSITORY')
    const eventName = getRequiredEnv('GITHUB_EVENT_NAME')

    const [owner, repo] = repository.split('/')
    const branchPrefix = 'refs/heads/'
    const tagPrefix = 'refs/tags/'

    if (!['push', 'pull_request'].includes(eventName)) {
      core.info(`Skipping unsupported event: ${eventName}`)
      return
    }

    const pullRequest = 'pull_request' === eventName

    let branch = getRequiredEnv(pullRequest ? 'GITHUB_HEAD_REF' : 'GITHUB_REF')
    if (!pullRequest && !branch.startsWith(branchPrefix)) {
      if (branch.startsWith(tagPrefix)) {
        core.info(`Skipping tag build: ${branch}`)
        return
      }
      const message = `${branch} was not an expected branch ref (refs/heads/).`
      throw new Error(message)
    }
    branch = branch.replace(branchPrefix, '')

    core.info(
      `Branch is ${branch}, repo is ${repo}, and owner is ${owner}, and id is ${selfRunId}`
    )

    cancelDuplicates(token, selfRunId, owner, repo, branch)
  } catch (error) {
    core.setFailed(error.message)
  }
}

function getRequiredEnv(key: string): string {
  const value = process.env[key]
  if (value === undefined) {
    const message = `${key} was not defined.`
    throw new Error(message)
  }
  return value
}

run()
