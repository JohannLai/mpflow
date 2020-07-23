import { Plugin } from '@weflow/service-core'
import { ConfigChain } from '@weflow/webpack-plugin'
import path from 'path'
import pkg from '../package.json'

const plugin: Plugin = (api, config) => {
  api.configureWebpack(webpackConfig => {
    webpackConfig.resolve.extensions.prepend('.ts').prepend('.tsx')

    webpackConfig.resolve
      .plugin('tsconfig-paths')
      .use(require('tsconfig-paths-webpack-plugin'), [{ configFile: api.resolve('tsconfig.json') }])

    webpackConfig.module
      .rule('ts')
      .test(/\.tsx?$/)
      .pre()
      .exclude.add(/node_modules/)
      .end()
      .use('babel-loader')
      .loader(webpackConfig.module.rule('js').use('babel-loader').get('loader'))
      .options(webpackConfig.module.rule('js').use('babel-loader').get('options'))

    webpackConfig.plugin('for-ts-checker').use(require('fork-ts-checker-webpack-plugin'), [{}])

    webpackConfig.plugin('weflow').tap(([config]: [ConfigChain]) => {
      config.resolve.page.extensions.add('.ts').add('.tsx')

      config.resolve.javascript.extensions.add('.ts').add('.tsx')

      return [config]
    })
  })
}

plugin.generator = async api => {
  api.extendPackage({
    dependencies: {
      typescript: pkg.devDependencies.typescript,
    },
  })

  api.render(path.resolve(__dirname, '../template'))

  api.processFile('src/**/*.js', (file, api) => {
    // js 文件重命名为 ts 文件
    api.rename(file.path.replace(/\.js$/, '.ts'))
  })
}

export default plugin
