import { BaseAPI, BaseService, Plugin, PluginInfo } from '@mpflow/service-core'
import axios from 'axios'
import cp from 'child_process'
import path from 'path'
import Stream from 'stream'
import { AsyncSeriesHook, AsyncSeriesWaterfallHook } from 'tapable'
import tar from 'tar'
import tmp from 'tmp'
import { Generator, GeneratorOptions } from './Generator'
import { exec, getLocalService, installNodeModules, renderFiles, syncFiles } from './utils'

export class CreatorAPI<
  P extends { creator?: any; generator?: any } = CreatorPlugin,
  S extends Creator<P> = Creator<P>
> extends BaseAPI<P, S> {
  async exec(command: string, args?: string[]): Promise<void> {
    await exec(this.service.context, command, args)
  }

  async installNodeModules(modules?: string[], options: { saveDev?: boolean } = {}): Promise<void> {
    return installNodeModules(this.service.context, modules, options)
  }

  async installPlugins(pluginNames: string[]): Promise<void> {
    return this.service.installPlugin(pluginNames)
  }

  tapPrepare(
    handler: (infos: {
      projectName: string
      appId: string
      templateName: string
    }) => Promise<{ projectName: string; appId: string; templateName: string }>,
  ): void {
    this.service.hooks.prepare.tapPromise(this.id, handler)
  }

  tapResolveTemplate(handler: (templateName: string) => Promise<string>): void {
    this.service.hooks.resolveTemplate.tapPromise(this.id, handler)
  }

  tapRender(
    handler: (infos: {
      projectName: string
      appId: string
      templatePath: string
    }) => Promise<{ projectName: string; appId: string; templatePath: string }>,
  ): void {
    this.service.hooks.render.tapPromise(this.id, handler)
  }

  tapBeforeEmit(handler: () => Promise<void>): void {
    this.service.hooks.beforeEmit.tapPromise(this.id, handler)
  }

  tapEmit(handler: () => Promise<void>): void {
    this.service.hooks.emit.tapPromise(this.id, handler)
  }

  tapInit(handler: () => Promise<void>): void {
    this.service.hooks.init.tapPromise(this.id, handler)
  }
}

export interface CreatorPlugin extends Plugin {
  creator?: (api: CreatorAPI) => void
}

export interface CreatorOptions extends GeneratorOptions {
  templateName?: string
  projectName?: string
  appId?: string
}

export class Creator<P extends { creator?: any; generator?: any } = CreatorPlugin> extends BaseService<P> {
  /**
   * 模板目录
   */
  public templateName?: string

  /**
   * 项目名称
   */
  public projectName?: string

  /**
   * 项目 APP id
   */
  public appId?: string

  /**
   *
   */
  public hooks = {
    /**
     * 准备阶段, 收集必要的创建信息
     */
    prepare: new AsyncSeriesWaterfallHook<{ projectName: string; appId: string; templateName: string }, never, never>([
      'infos',
    ]),
    /**
     * 解析输入的 template 模板
     */
    resolveTemplate: new AsyncSeriesWaterfallHook<string, never, never>(['templateName']),
    /**
     * 将模板渲染到内存中的虚拟文件系统
     */
    render: new AsyncSeriesHook<
      { projectName: string; appId: string; templatePath: string },
      Record<string, string>,
      never
    >(['infos', 'files']),
    /**
     * 将渲染模板输出前回调
     */
    beforeEmit: new AsyncSeriesHook<Record<string, string>>(['files']),
    /**
     * 将渲染模板真正输出到目录
     */
    emit: new AsyncSeriesHook<string, Record<string, string>>(['context', 'files']),
    /**
     * 初始化项目
     */
    init: new AsyncSeriesHook<string>(['context']),
    /**
     * 初始化结束后
     */
    afterInit: new AsyncSeriesHook<string>(['context']),
  }

  constructor(context: string, { templateName, projectName, appId, ...options }: CreatorOptions) {
    super(context, options)

    this.templateName = templateName
    this.projectName = projectName
    this.appId = appId

    this.hooks.resolveTemplate.tapPromise('creator', async templateName => {
      return this.getTemplatePath(templateName)
    })

    this.hooks.render.tapPromise('creator', async ({ projectName, appId, templatePath }, files) => {
      const rendered = await renderFiles(this.inputFileSystem, templatePath, '**/*', {
        projectName,
        appId,
      })
      Object.assign(files, rendered)
    })

    this.hooks.emit.tapPromise('creator', async (context, files) => {
      await syncFiles(this.outputFileSystem, context, files)
    })

    this.hooks.init.tapPromise('creator', async context => {
      // npm install
      await installNodeModules(context)
      // await this.installNodeModules()
      // npm install @mpflow/service
      await installNodeModules(this.context, ['@mpflow/service'])

      // 执行内置插件的 generator
      const localService = getLocalService(this.context)
      const plugins: PluginInfo[] = localService.ServiceRunner.getBuiltInPlugins()
      const generator = new Generator(this.context, { plugins })

      await generator.generate(false)
    })
  }

  /**
   * 根据传入的 templateName, 下载包或者使用本地包, 返回下载解压后的所在目录
   * @param templateName
   */
  async getTemplatePath(templateName: string): Promise<string> {
    console.log(`使用 "${templateName}" 为项目模板`)
    let localTemplatePath: string
    if (templateName.startsWith('file://')) {
      // file: 开头为本地路径，不要下载
      localTemplatePath = path.join(path.resolve(templateName.substr(7)), 'template')
      console.log(`检测为本地模板，使用 "${localTemplatePath}"`)
    } else {
      // 创建一个临时目录用于下载解压
      const tmpPath = await new Promise<string>((resolve, reject) => {
        tmp.dir({ unsafeCleanup: true }, (err, tmpDir) => (err ? reject(err) : resolve(tmpDir)))
      })

      let downloadUrl = templateName
      // 如果不是 url 链接，则通过 npm 获取下载 url
      if (!/^https?:\/\//.test(templateName)) {
        console.log(`从 npm 获取 "${templateName}" 的下载路径`)
        downloadUrl = cp.execSync(`npm info ${templateName} dist.tarball`, { encoding: 'utf8' }).trim()
      }

      // 下载并解压到临时目录
      console.log(`下载 ${downloadUrl}`)
      const { data: downloadStream } = await axios.get<Stream>(downloadUrl, { responseType: 'stream' })
      await new Promise((resolve, reject) => {
        downloadStream
          .pipe(
            tar.x({
              C: tmpPath,
            }),
          )
          .on('error', err => reject(err))
          .on('close', () => resolve())
      })
      localTemplatePath = path.join(tmpPath, 'package', 'template')
    }
    return localTemplatePath
  }

  async create(): Promise<void> {
    await this.initPlugins()

    const { projectName, appId, templateName } = await this.hooks.prepare.promise({
      projectName: this.projectName || '',
      appId: this.appId || '',
      templateName: this.templateName || '',
    })

    const templatePath = await this.hooks.resolveTemplate.promise(templateName)
    const files: Record<string, string> = {}

    await this.hooks.render.promise({ projectName, appId, templatePath }, files)

    await this.hooks.beforeEmit.promise(files)
    await this.hooks.emit.promise(this.context, files)

    await this.hooks.init.promise(this.context)
    await this.hooks.afterInit.promise(this.context)
  }

  /**
   * 安装插件到项目
   * @param pluginNames
   */
  async installPlugin(pluginNames: string[]): Promise<void> {
    if (!pluginNames.length) return
    await installNodeModules(this.context, pluginNames)

    const generator = new Generator(this.context, { plugins: pluginNames.map(id => ({ id })) })

    // 将插件添加到 mpflow.config.js
    generator.processFile('creator', 'mpflow.config.js', (file, api) => {
      api.transform(require('@mpflow/service-core/lib/codemods/add-to-exports').default, {
        fieldName: 'plugins',
        items: pluginNames,
      })
    })

    await generator.generate(true)
  }

  /**
   * 获取所有插件
   * @param inlinePlugins
   * @param config
   */
  resolvePluginInfos(inlinePlugins: PluginInfo<P>[] = []): PluginInfo<P>[] {
    const buildInPlugins: PluginInfo<P>[] = [
      {
        id: '@mpflow/cli/lib/creator-plugins/request-app-id',
        module: require('./creator-plugins/request-app-id'),
      },
      {
        id: '@mpflow/cli/lib/creator-plugins/recommended',
        module: require('./creator-plugins/recommended'),
      },
      {
        id: '@mpflow/cli/lib/creator-plugins/init-git',
        module: require('./creator-plugins/init-git'),
      },
    ]

    return [...buildInPlugins, ...inlinePlugins]
  }

  /**
   * 执行所有的插件 generator
   */
  async initPlugins(): Promise<void> {
    const plugins = this.resolvePlugins()

    plugins.forEach(({ id, plugin }) => {
      plugin.creator && plugin.creator(new CreatorAPI<P>(id, this))
    })
  }
}
