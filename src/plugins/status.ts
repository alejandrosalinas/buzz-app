// Contribution services observe readiness without access to plugin management.
declare module "@deepseek-ai/cordis" {
  interface Context {
    pluginStatus: {
      isActive(id: string, revision: string): boolean;
      subscribe(listener: () => void): () => void;
      /** Whether startup is over: the plugin settings are read, or need the
       * user, and no plugin is still starting. Without it, startup is over. */
      settled?(): boolean;
      /** Like `settled`, for bundled plugins only: the plugin settings are
       * read, or need the user, and no bundled plugin is still starting. */
      bundledSettled?(): boolean;
      /** The base prompt sections plugin `id` declared, while the plugin is
       * active. Only the IDs: a plugin's `pluginOwner` stays in its scope. */
      promptSections?(id: string): readonly string[] | undefined;
      /** Whether plugin `id` is on: it is starting, is active, or failed to
       * start. A plugin that is on can become active without the user. */
      on?(id: string): boolean;
    };
  }
}
export {};
