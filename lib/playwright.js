import fs from "node:fs"
import lodash from 'lodash'
import chokidar from "chokidar"
import template from "art-template"
import playwright from 'playwright';

const _path = process.cwd()

class Playwright {
  constructor(config) {
    this.browser = null;
    this.browserType = config?.browserType || 'chromium';
    this.lock = false;
    this.launchOptions = {
      headless: config?.headless || true,
      args: config?.args || [],
    };
    if (config.executablePath) {
      /** chromium其他路径 */
      this.launchOptions.executablePath = config.executablePath
    }
    /** 截图数达到时重启浏览器 避免生成速度越来越慢 */
    this.restartNum = 100
    /** 截图次数 */
    this.shoting = []
    this.renderNum = 0
    this.html = {}
    this.watcher = {}
    this.createDir('./temp/html')
  }

  async browserInit() {
    // 等待直到锁释放
    while (this.lock) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (this.browser) {
      return this.browser;
    }

    // 上锁
    this.lock = true;
    try {
      // TODO: 从 yaml 中读取配置文件
      this.browser = await playwright.firefox.launch(this.launchOptions);
      this.browser = await playwright[this.browserType].launch(this.launchOptions);
      this.browser.on("disconnected", (_) => {
        logger.error('浏览器实例关闭或崩溃！')
        this.browser = null;
      });
    } catch (err) {
      console.log("playwright 启动失败: ", err);
      this.lock = false;
      return false;
    }

    // 解锁
    this.lock = false;
    return this.browser;
  }

  createDir(dir) {
    if (!fs.existsSync(dir)) {
      let dirs = dir.split('/')
      for (let idx = 1; idx <= dirs.length; idx++) {
        let temp = dirs.slice(0, idx).join('/')
        if (!fs.existsSync(temp)) {
          fs.mkdirSync(temp)
        }
      }
    }
  }

  /** 模板 */
  dealTpl(name, data) {
    let { tplFile, saveId = name } = data
    let savePath = `./temp/html/${name}/${saveId}.html`

    /** 读取html模板 */
    if (!this.html[tplFile]) {
      this.createDir(`./temp/html/${name}`)

      try {
        this.html[tplFile] = fs.readFileSync(tplFile, 'utf8')
      } catch (error) {
        logger.error(`加载html错误：${tplFile}`)
        return false
      }

      this.watch(tplFile)
    }

    data.resPath = `${_path}/resources/`

    /** 替换模板 */
    let tmpHtml = template.render(this.html[tplFile], data)

    /** 保存模板 */
    fs.writeFileSync(savePath, tmpHtml)

    logger.debug(`[图片生成][使用模板] ${savePath}`)

    return savePath
  }

  /** 监听配置文件 */
  watch(tplFile) {
    if (this.watcher[tplFile]) return

    const watcher = chokidar.watch(tplFile)
    watcher.on('change', path => {
      delete this.html[tplFile]
      logger.mark(`[修改html模板] ${tplFile}`)
    })

    this.watcher[tplFile] = watcher
  }

  /** 重启 */
  restart() {
    /** 截图超过重启数时，自动关闭重启浏览器，避免生成速度越来越慢 */
    if (this.renderNum % this.restartNum === 0) {
      if (this.shoting.length <= 0) {
        setTimeout(async () => {
          if (this.browser) {
            await this.browser.close().catch((err) => logger.error(err))
          }
          this.browser = null
          logger.mark('playwright 关闭重启...')
        }, 100)
      }
    }
  }

  /**
   * `chromium` 截图
   * @param data 模板参数
   * @param data.tplFile 模板路径，必传
   * @param data.saveId  生成html名称，为空name代替
   * @param data.imgType  screenshot参数，生成图片类型：jpeg，png
   * @param data.quality  screenshot参数，图片质量 0-100，jpeg是可传，默认90
   * @param data.omitBackground  screenshot参数，隐藏默认的白色背景，背景透明。默认不透明
   * @param data.path   screenshot参数，截图保存路径。截图图片类型将从文件扩展名推断出来。如果是相对路径，则从当前路径解析。如果没有指定路径，图片将不会保存到硬盘。
   * @param data.multiPage 是否分页截图，默认false
   * @param data.multiPageHeight 分页状态下页面高度，默认4000
   * @param data.pageGotoParams 页面goto时的参数
   * @return img/[]img 不做segment包裹
   */
  async screenshot(name, data = {}) {
    if (!await this.browserInit()) {
      return false;
    }
    const pageHeight = data.multiPageHeight || 4000

    let savePath = this.dealTpl(name, data)
    if (!savePath) return false

    let buff = ''
    let start = Date.now()

    let ret = []
    this.shoting.push(name)

    try {
      const page = await this.browser.newPage()
      // TODO data.pageGotoParams
      let pageGotoParams = {}
      await page.goto(`file://${_path}${lodash.trim(savePath, '.')}`, pageGotoParams)
      let body = await page.$('#container') || await page.$('body')

      // 计算页面高度
      const boundingBox = await body.boundingBox()
      // 分页数
      let num = 1

      let randData = {
        type: data.imgType || 'jpeg',
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || ''
      }

      if (data.multiPage) {
        randData.type = 'jpeg'
        num = Math.round(boundingBox.height / pageHeight) || 1
      }

      if (data.imgType === 'png') {
        delete randData.quality
      }

      if (!data.multiPage) {
        buff = await body.screenshot(randData)
        /** 计算图片大小 */
        const kb = (buff.length / 1024).toFixed(2) + 'kb'
        logger.mark(`[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`)
        this.renderNum++
        ret.push(buff)
      } else {
        // 分片截图
        if (num > 1) {
          await page.setViewportSize({
            width: boundingBox.width,
            height: pageHeight + 100
          })
        }
        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num) {
            await page.setViewportSize({
              width: boundingBox.width,
              height: parseInt(boundingBox.height) - pageHeight * (num - 1)
            })
          }
          if (i !== 1 && i <= num) {
            await page.evaluate(pageHeight => window.scrollBy(0, pageHeight), pageHeight)
          }
          if (num === 1) {
            buff = await body.screenshot(randData)
          } else {
            buff = await page.screenshot(randData)
          }
          if (num > 2) await new Promise(resolve => setTimeout(resolve, 200))
          this.renderNum++

          /** 计算图片大小 */
          const kb = (buff.length / 1024).toFixed(2) + 'kb'
          logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
          ret.push(buff)
        }
        if (num > 1) {
          logger.mark(`[图片生成][${name}] 处理完成`)
        }
      }
      page.close().catch((err) => logger.error(err))

    } catch (error) {
      logger.error(`图片生成失败:${name}:${error}`)
      /** 关闭浏览器 */
      if (this.browser) {
        await this.browser.close().catch((err) => logger.error(err))
      }
      this.browser = false
      ret = []
      return false
    }

    this.shoting.pop()

    if (ret.length === 0 || !ret[0]) {
      logger.error(`图片生成为空:${name}`)
      return false
    }

    this.restart()

    return data.multiPage ? ret : ret[0]
  }
}

export default Playwright;
