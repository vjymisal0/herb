import { dirname } from "node:path"

import { Config } from "@herb-tools/config"

import { Workspace } from "./workspace"
import { pathFromUri } from "./utils"

import type { Connection } from "vscode-languageserver/node"
import type { Settings } from "./settings"
import type { SharedServices } from "./workspace"

const FILE_SCHEME = "file://"

/**
 * Herb resolves a project by walking up for a `.herb.yml`, so a workspace
 * folder is a boundary rather than a unit. One folder can hold several projects
 * and each of them gets its own config, linter and partial index, keyed by the
 * root that `Config` itself would pick for a file.
 */
export class Workspaces {
  private readonly connection: Connection
  private readonly settings: Settings
  private readonly shared: SharedServices

  private readonly byRoot: Map<string, Workspace> = new Map()
  private readonly rootByDirectory: Map<string, string> = new Map()

  constructor(connection: Connection, settings: Settings, shared: SharedServices) {
    this.connection = connection
    this.settings = settings
    this.shared = shared
  }

  all(): Workspace[] {
    return [...this.byRoot.values()]
  }

  /**
   * Resolves without creating, for the request handlers that cannot wait for a
   * workspace to index. A document is always opened before anything is asked
   * about it, and opening it goes through `ensure`.
   */
  get(uri: string): Workspace | null {
    const root = this.rootFor(uri)

    return root === null ? null : this.byRoot.get(root) ?? null
  }

  async ensure(uri: string): Promise<Workspace | null> {
    const root = this.rootFor(uri)

    if (root === null) return null

    const existing = this.byRoot.get(root)

    if (existing) return existing

    const workspace = new Workspace(this.connection, this.settings, root, this.shared)

    this.byRoot.set(root, workspace)

    await workspace.initialize()

    this.connection.console.log(`[Workspace] Indexed ${root}`)

    return workspace
  }

  containing(path: string): Workspace | null {
    let best: Workspace | null = null

    for (const workspace of this.byRoot.values()) {
      if (!workspace.contains(path)) continue
      if (best === null || workspace.root.length > best.root.length) best = workspace
    }

    return best
  }

  /**
   * Drops the workspaces whose root no longer sits inside a folder the client
   * has open, so a removed folder stops carrying an index and a config around.
   */
  prune(): string[] {
    const dropped = this.all().filter(workspace => !this.settings.containsPath(workspace.root))

    for (const workspace of dropped) {
      this.remove(workspace.root)
    }

    this.forget()

    return dropped.map(workspace => workspace.root)
  }

  remove(root: string): boolean {
    for (const [directory, cached] of this.rootByDirectory) {
      if (cached === root) this.rootByDirectory.delete(directory)
    }

    return this.byRoot.delete(root)
  }

  /**
   * A new or deleted `.herb.yml` moves the boundary between projects, so the
   * directory to root answers cached either side of it stop being true.
   */
  forget() {
    this.rootByDirectory.clear()
  }

  private rootFor(uri: string): string | null {
    if (!uri.startsWith(FILE_SCHEME)) return null
    if (!this.settings.includes(uri)) return null

    const directory = dirname(pathFromUri(uri))
    const cached = this.rootByDirectory.get(directory)

    if (cached !== undefined) return cached

    const root = Config.findProjectRootSync(directory)

    this.rootByDirectory.set(directory, root)

    return root
  }
}
