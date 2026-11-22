/** Run the opt-in ACP integration using Source services and freshly generated Typert wire definitions. */
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true }), standardDecoratorPlugin()],
  test: {
    pool: 'forks',
    execArgv: vitestExecArgv,
    include: ['packages/api/session-controller/tests/subscriptions-agy-native.host.spec.ts'],
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-official-listing-guard.ts'],
  },
})
