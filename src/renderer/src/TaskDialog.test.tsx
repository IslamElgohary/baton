import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FinishPanel, finishButtonLabel, TaskDialog } from './TaskDialog'
import type { Board, Column, Task } from '../../shared/types'

describe('finishButtonLabel', () => {
  it('returns appropriate labels for merge mode', () => {
    expect(finishButtonLabel({ finish_mode: 'merge', base_branch: 'main' }, { pr_url: null })).toBe('⇡ Merge into main')
    expect(finishButtonLabel({ finish_mode: 'merge', base_branch: 'develop' }, { pr_url: 'https://github.com/foo/bar/pull/1' })).toBe('⇡ Merge into develop')
  })

  it('returns appropriate labels for pr mode', () => {
    expect(finishButtonLabel({ finish_mode: 'pr', base_branch: 'main' }, { pr_url: null })).toBe('⇡ Open PR')
    expect(finishButtonLabel({ finish_mode: 'pr', base_branch: 'main' }, { pr_url: 'https://github.com/foo/bar/pull/1' })).toBe('⇡ Update PR')
  })

  it('returns appropriate labels for publish mode', () => {
    expect(finishButtonLabel({ finish_mode: 'publish', base_branch: 'main' }, { pr_url: null })).toBe('⇡ Publish branch')
  })

  it('returns appropriate labels for notify mode', () => {
    expect(finishButtonLabel({ finish_mode: 'notify', base_branch: 'main' }, { pr_url: null })).toBe('✓ Mark finished')
  })
})

describe('FinishPanel', () => {
  const dummyBoard: Board = {
    id: 1,
    name: 'Test Board',
    repo_path: '/path/to/repo',
    base_branch: 'main',
    finish_mode: 'merge',
  }

  const baseTask: Task = {
    id: 10,
    board_id: 1,
    epic_id: null,
    column_id: 2,
    position: 0,
    title: 'Test task',
    description: '',
    branch: 'task-10',
    worktree_path: '/path/to/repo/.worktrees/10',
    status: 'idle',
    artifacts: 0,
    blocked_by: [],
    blocked: false,
    resolved: false,
    auto_start: 0,
    merged_at: null,
    merge_base: null,
    pr_url: null,
    published_at: null,
    finished_at: null,
    finish_error: null,
    archived_at: null,
    attention: null,
  }

  const dummyAct = () => Promise.resolve()

  it('renders null when task has no branch', () => {
    const html = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, branch: null }} board={dummyBoard} busy={false} act={dummyAct} />
    )
    expect(html).toBe('')
  })

  it('renders mode-specific primary button labels', () => {
    const mergeHtml = renderToStaticMarkup(
      <FinishPanel task={baseTask} board={{ ...dummyBoard, finish_mode: 'merge' }} busy={false} act={dummyAct} />
    )
    expect(mergeHtml).toContain('⇡ Merge into main')

    const prOpenHtml = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, pr_url: null }} board={{ ...dummyBoard, finish_mode: 'pr' }} busy={false} act={dummyAct} />
    )
    expect(prOpenHtml).toContain('⇡ Open PR')

    const prUpdateHtml = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, pr_url: 'https://github.com/foo/bar/pull/1' }} board={{ ...dummyBoard, finish_mode: 'pr' }} busy={false} act={dummyAct} />
    )
    expect(prUpdateHtml).toContain('⇡ Update PR')

    const publishHtml = renderToStaticMarkup(
      <FinishPanel task={baseTask} board={{ ...dummyBoard, finish_mode: 'publish' }} busy={false} act={dummyAct} />
    )
    expect(publishHtml).toContain('⇡ Publish branch')

    const notifyHtml = renderToStaticMarkup(
      <FinishPanel task={baseTask} board={{ ...dummyBoard, finish_mode: 'notify' }} busy={false} act={dummyAct} />
    )
    expect(notifyHtml).toContain('✓ Mark finished')
  })

  it('renders completion status indicators for all modes', () => {
    const mergedHtml = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, merged_at: '2026-01-01T00:00:00Z' }} board={dummyBoard} busy={false} act={dummyAct} />
    )
    expect(mergedHtml).toContain('✓ merged into main')

    const prHtml = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, pr_url: 'https://github.com/foo/bar/pull/42' }} board={{ ...dummyBoard, finish_mode: 'pr' }} busy={false} act={dummyAct} />
    )
    expect(prHtml).toContain('https://github.com/foo/bar/pull/42')

    const publishedHtml = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, branch: 'feature-abc', published_at: '2026-01-01T00:00:00Z' }} board={{ ...dummyBoard, finish_mode: 'publish' }} busy={false} act={dummyAct} />
    )
    expect(publishedHtml).toContain('✓ pushed to origin/feature-abc')

    const finishedHtml = renderToStaticMarkup(
      <FinishPanel task={{ ...baseTask, finished_at: '2026-01-01T00:00:00Z' }} board={{ ...dummyBoard, finish_mode: 'notify' }} busy={false} act={dummyAct} />
    )
    expect(finishedHtml).toContain('✓ finished')
  })
})

describe('TaskDialog Copy path button', () => {
  const dummyBoard: Board = {
    id: 1,
    name: 'Test Board',
    repo_path: '/path/to/repo',
    base_branch: 'main',
    finish_mode: 'merge',
  }

  const dummyColumn: Column = {
    id: 2,
    board_id: 1,
    name: 'In Progress',
    position: 1,
    is_done: 0,
    finish_on_enter: 0,
    trigger: null,
  }

  const taskWithPath: Task = {
    id: 10,
    board_id: 1,
    epic_id: null,
    column_id: 2,
    position: 0,
    title: 'Test task',
    description: '',
    branch: 'task-10',
    worktree_path: '/Users/test/repo/.worktrees/10',
    status: 'idle',
    artifacts: 0,
    blocked_by: [],
    blocked: false,
    resolved: false,
    auto_start: 0,
    merged_at: null,
    merge_base: null,
    pr_url: null,
    published_at: null,
    finished_at: null,
    finish_error: null,
    archived_at: null,
    attention: null,
  }

  const dummyAct = () => Promise.resolve()

  it('renders Open worktree and Copy path when worktree_path is non-null across all finish modes', () => {
    for (const mode of ['merge', 'pr', 'publish', 'notify'] as const) {
      const html = renderToStaticMarkup(
        <TaskDialog
          task={taskWithPath}
          tasks={[taskWithPath]}
          columns={[dummyColumn]}
          board={{ ...dummyBoard, finish_mode: mode }}
          epics={[]}
          artifacts={[]}
          runs={[]}
          busy={false}
          act={dummyAct}
          onClose={() => {}}
        />
      )
      expect(html).toContain('Open worktree')
      expect(html).toContain('Copy path')
    }
  })

  it('does not render Open worktree or Copy path when worktree_path is null', () => {
    const taskWithoutPath: Task = {
      ...taskWithPath,
      worktree_path: null,
    }

    const html = renderToStaticMarkup(
      <TaskDialog
        task={taskWithoutPath}
        tasks={[taskWithoutPath]}
        columns={[dummyColumn]}
        board={dummyBoard}
        epics={[]}
        artifacts={[]}
        runs={[]}
        busy={false}
        act={dummyAct}
        onClose={() => {}}
      />
    )
    expect(html).not.toContain('Open worktree')
    expect(html).not.toContain('Copy path')
  })
})
