// Picks the browser engine for the e2e tests: PC98_BROWSER=chromium (default), webkit or firefox.
import * as playwright from 'playwright';

export const engine = process.env.PC98_BROWSER ?? 'chromium';

export function launchBrowser() {
  const type = playwright[engine];
  if (!type) throw new Error(`Unknown PC98_BROWSER ${engine}`);
  return type.launch(engine === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
}
