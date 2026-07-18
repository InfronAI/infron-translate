import { PageController } from './page-controller'

// Guard against double-mount: on install/update the worker re-injects this script
// into already-open tabs (see sw.ts), which can race with the manifest injection.
const MOUNT_FLAG = '__infronTranslateMounted'
const globalScope = window as unknown as Record<string, unknown>

async function main(): Promise<void> {
  if (globalScope[MOUNT_FLAG]) return
  globalScope[MOUNT_FLAG] = true
  const controller = new PageController()
  controller.bindListeners()
  await controller.refreshSettings()
}

void main()
