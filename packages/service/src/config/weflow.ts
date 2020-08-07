import { Plugin } from '@mpflow/service-core'
import MpflowPlugin, { ConfigChain } from '@mpflow/webpack-plugin'
import path from 'path'

const ChainedPlugin = require('webpack-chain/src/Plugin')

class PluginMpflow extends ChainedPlugin {
  constructor(parent: any, name: string, type = 'plugin') {
    super(parent, name, type)
  }

  toConfig() {
    // 调用之前把 args 给转成 config
    const originalArgs = this.get('args')
    this.set(
      'args',
      originalArgs.map((a: any) => (a.toConfig ? a.toConfig() : a)),
    )

    const config = super.toConfig()

    this.set('args', originalArgs)

    return config
  }
}

const mpflow: Plugin = (api, config) => {
  let emitProjectConfig = false

  api.beforeConfigureWebpack(() => {
    api.configureWebpack(webpackConfig => {
      webpackConfig.plugins
        .getOrCompute('mpflow', () => new PluginMpflow(webpackConfig, 'mpflow') as any)
        .use(MpflowPlugin, [new ConfigChain() as any])

      webpackConfig.plugin('mpflow').tap(([mpflowConfig]: [ConfigChain]) => {
        mpflowConfig.resolve.roots.add(api.resolve(config.sourceDir || 'src'))

        // 找一个 webpack 生成 project.config.json
        if (!emitProjectConfig) {
          mpflowConfig.program
            .appId(config.appId)
            .outputPath(
              path.relative(
                webpackConfig.output.get('path'),
                api.resolve(config.outputDir || 'dist', 'project.config.json'),
              ),
            )
            .projectName(api.getProjectName())
            .compileType(config.compileType)
            .miniprogramRoot(config.miniprogramRoot)
            .qcloudRoot(config.qcloudRoot)
            .pluginRoot(config.pluginRoot)

          emitProjectConfig = true
        }

        return [mpflowConfig]
      })
    })

    // app 构建的 root 设置为 miniprogramRoot
    if (api.hasWebpackConfig('app')) {
      api.configureWebpack('app', webpackConfig => {
        webpackConfig.plugin('mpflow').tap(([mpflowConfig]: [ConfigChain]) => {
          mpflowConfig.resolve.roots.add(api.resolve(config.sourceDir || 'src', config.miniprogramRoot || ''))
          return [mpflowConfig]
        })
      })
    }

    // plugin 构建的 root 设置为 pluginRoot
    if (api.hasWebpackConfig('plugin')) {
      api.configureWebpack('plugin', webpackConfig => {
        webpackConfig.plugin('mpflow').tap(([mpflowConfig]: [ConfigChain]) => {
          mpflowConfig.resolve.roots.add(api.resolve(config.sourceDir || 'src', config.pluginRoot || ''))
          return [mpflowConfig]
        })
      })
    }
  })
}

export default mpflow
