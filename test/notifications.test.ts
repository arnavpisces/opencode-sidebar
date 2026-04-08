import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { NotificationTracker } from "../src/lib/notifications.js"
import { buildSnapshot } from "../src/lib/model.js"

function buildEmptySnapshot() {
  return buildSnapshot({
    baseUrl: "http://127.0.0.1:42112",
    serverPort: 42112,
    pinnedDirectories: [],
    panes: [],
    projects: [],
    sessions: [],
  })
}

describe("NotificationTracker", () => {
  test("emits an attention notification when a question is asked", () => {
    const tracker = new NotificationTracker(() => 10_000)
    tracker.syncSnapshot(buildEmptySnapshot())

    const effects = tracker.handleEvent({
      directory: "/tmp/project",
      event: {
        type: "question.asked",
        properties: {
          id: "question_1",
          sessionID: "session_1",
          questions: [
            {
              header: "Confirm",
              question: "Proceed?",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        },
      } as Event,
    })

    expect(effects).toEqual([
      {
        id: "question:question_1",
        kind: "attention",
        title: "OpenCode needs input",
        detail: "/tmp/project",
      },
    ])
  })

  test("emits an attention notification for pending questions discovered on sync", () => {
    const tracker = new NotificationTracker(() => 10_000)
    tracker.syncSnapshot(buildEmptySnapshot())

    const effects = tracker.syncPendingRequests({
      questions: [
        {
          id: "question_1",
          sessionID: "session_1",
          questions: [
            {
              header: "Confirm",
              question: "Proceed?",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        },
      ],
      permissions: [],
    })

    expect(effects).toEqual([
      {
        id: "question:question_1",
        kind: "attention",
        title: "OpenCode needs input",
        detail: "Pending question",
      },
    ])

    expect(
      tracker.syncPendingRequests({
        questions: [
          {
            id: "question_1",
            sessionID: "session_1",
            questions: [
              {
                header: "Confirm",
                question: "Proceed?",
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
          },
        ],
        permissions: [],
      }),
    ).toEqual([])
  })

  test("emits a completion notification when a busy session becomes idle", () => {
    let now = 10_000
    const tracker = new NotificationTracker(() => now)
    tracker.syncSnapshot(
      buildSnapshot({
        baseUrl: "http://127.0.0.1:42112",
        serverPort: 42112,
        pinnedDirectories: [],
        panes: [],
        projects: [],
        sessions: [
          {
            id: "session_busy",
            title: "Build notifier",
            directory: "/tmp/project",
            status: { type: "busy" },
            time: { created: 1, updated: 10 },
            project: null,
          },
        ],
      }),
    )

    now = 20_000
    const effects = tracker.handleEvent({
      directory: "/tmp/project",
      event: {
        type: "session.idle",
        properties: {
          sessionID: "session_busy",
        },
      } as Event,
    })

    expect(effects).toEqual([
      {
        id: "completion:session_busy:10",
        kind: "completion",
        title: "Build notifier",
        detail: "/tmp/project",
      },
    ])
  })

  test("suppresses duplicate completion notifications in a short window", () => {
    let now = 10_000
    const tracker = new NotificationTracker(() => now)
    tracker.syncSnapshot(
      buildSnapshot({
        baseUrl: "http://127.0.0.1:42112",
        serverPort: 42112,
        pinnedDirectories: [],
        panes: [],
        projects: [],
        sessions: [
          {
            id: "session_busy",
            title: "Build notifier",
            directory: "/tmp/project",
            status: { type: "busy" },
            time: { created: 1, updated: 10 },
            project: null,
          },
        ],
      }),
    )

    now = 12_000
    expect(
      tracker.handleEvent({
        directory: "/tmp/project",
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session_busy",
          },
        } as Event,
      }),
    ).toHaveLength(1)

    tracker.handleEvent({
      directory: "/tmp/project",
      event: {
        type: "session.status",
        properties: {
          sessionID: "session_busy",
          status: { type: "busy" },
        },
      } as Event,
    })

    now = 14_000
    expect(
      tracker.handleEvent({
        directory: "/tmp/project",
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session_busy",
          },
        } as Event,
      }),
    ).toEqual([])
  })

  test("drops completion suppression state when a session disappears from snapshots", () => {
    let now = 10_000
    const tracker = new NotificationTracker(() => now)

    tracker.syncSnapshot(
      buildSnapshot({
        baseUrl: "http://127.0.0.1:42112",
        serverPort: 42112,
        pinnedDirectories: [],
        panes: [],
        projects: [],
        sessions: [
          {
            id: "session_busy",
            title: "Build notifier",
            directory: "/tmp/project",
            status: { type: "busy" },
            time: { created: 1, updated: 10 },
            project: null,
          },
        ],
      }),
    )

    now = 20_000
    expect(
      tracker.handleEvent({
        directory: "/tmp/project",
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session_busy",
          },
        } as Event,
      }),
    ).toHaveLength(1)

    tracker.syncSnapshot(buildEmptySnapshot())
    tracker.syncSnapshot(
      buildSnapshot({
        baseUrl: "http://127.0.0.1:42112",
        serverPort: 42112,
        pinnedDirectories: [],
        panes: [],
        projects: [],
        sessions: [
          {
            id: "session_busy",
            title: "Build notifier",
            directory: "/tmp/project",
            status: { type: "busy" },
            time: { created: 1, updated: 30 },
            project: null,
          },
        ],
      }),
    )

    now = 22_000
    expect(
      tracker.handleEvent({
        directory: "/tmp/project",
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session_busy",
          },
        } as Event,
      }),
    ).toHaveLength(1)
  })
})
