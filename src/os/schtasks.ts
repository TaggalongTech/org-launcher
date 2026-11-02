/**
 * Windows: a Task Scheduler task that runs the server at logon. The server moves into its own folder
 * when it starts, so the task needs no start-in folder. A task can't carry its own environment: the
 * server finds that folder from the user's ORG_LAUNCHER_HOME, or uses the default one. So the task is
 * read back as all nulls (readsBack is false): commands treat it as their own, whatever their folder.
 */
import { mustRun, refuseLineBreaks, type LoginService, type Registration, type Run } from './loginService.js';

export const TASK_NAME = 'Org Launcher';

/**
 * The task's command line: both paths in double quotes, so spaces stay inside them. Windows paths can't
 * contain a double quote. Passed as one argument, Node quotes it again for schtasks.
 */
export function schtasksCommand(nodePath: string, serverJs: string): string {
  refuseLineBreaks(nodePath, serverJs);
  return `"${nodePath}" "${serverJs}"`;
}

export function schtasksService(run: Run): LoginService {
  const schtasks = (what: string, ...args: string[]): Promise<void> => mustRun(run, what, 'schtasks', args);
  const end = (): Promise<unknown> => run('schtasks', ['/End', '/TN', TASK_NAME]); // Fails when it isn't running.

  return {
    async register(nodePath, serverJs): Promise<void> {
      const command = schtasksCommand(nodePath, serverJs);
      await end();
      const what = "Couldn't start Org Launcher at login";
      await schtasks(what, '/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', command);
      try {
        await schtasks(what, '/Run', '/TN', TASK_NAME);
      } catch (error) {
        // Nothing half-registered: a task that won't run would only get in the way.
        await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
        throw error;
      }
    },

    async unregister(): Promise<void> {
      await end();
      await schtasks("Couldn't remove the login service", '/Delete', '/TN', TASK_NAME, '/F');
    },

    async registration(): Promise<Registration | null> {
      if ((await run('schtasks', ['/Query', '/TN', TASK_NAME])).code !== 0) return null;
      return { nodePath: null, serverJs: null, home: null };
    },

    readsBack: false,

    start(): Promise<void> {
      return schtasks("Couldn't start Org Launcher", '/Run', '/TN', TASK_NAME);
    },

    async stop(): Promise<void> {
      // A task that isn't running is already stopped. The server's pid file is cleared by the caller.
      await end();
    },
  };
}
