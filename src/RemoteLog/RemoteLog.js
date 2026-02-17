import Tool from '../DevTools/Tool'
import evalCss from '../lib/evalCss'
import { classPrefix as c } from '../lib/util'

export default class RemoteLog extends Tool {
  constructor() {
    super()
    this._style = evalCss(require('./RemoteLog.scss'))
    this.name = 'remote-log'
    this._isRunning = false
    this._url = ''
    this._buffer = []
    this._timer = null
    this._sentCount = 0
    this._originalConsole = {}
  }

  init($el, container) {
    super.init($el)
    this._container = container
    this._render()
    this._bindEvent()
  }

  destroy() {
    super.destroy()
    this._stop()
    evalCss.remove(this._style)
  }

  _render() {
    const html = `
      <div class="${c('section')}">
        <h2 class="${c('title')}">Remote Log</h2>
        <div class="${c('content')}">
          <div class="${c('input-group')}">
            <input
              type="text"
              class="${c('url-input')}"
              placeholder="https://your-server.com/api/logs"
            />
          </div>
          <button class="${c('toggle-btn')}">Start</button>
          <div class="${c('status')}">Status: Stopped</div>
          <div class="${c('stats')}">Logs sent: 0</div>
        </div>
      </div>
    `
    this._$el.html(html)
  }

  _bindEvent() {
    const $el = this._$el

    $el.on('click', c('.toggle-btn'), () => {
      if (this._isRunning) {
        this._stop()
      } else {
        this._start()
      }
    })
  }

  _start() {
    const $input = this._$el.find(c('.url-input'))
    const url = $input.val().trim()

    if (!url) {
      this._container.notify('Please enter a URL', { icon: 'error' })
      return
    }

    this._url = url
    this._isRunning = true
    this._sentCount = 0
    this._buffer = []

    this._hookConsole()
    this._timer = setInterval(() => this._flush(), 500)

    this._updateUI()
    this._container.notify('Remote logging started', { icon: 'success' })
  }

  _stop() {
    if (!this._isRunning) return

    this._isRunning = false
    this._restoreConsole()

    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }

    // ส่ง logs ที่เหลือ
    this._flush()

    this._updateUI()
    this._container.notify('Remote logging stopped', { icon: 'success' })
  }

  _hookConsole() {
    const methods = ['log', 'warn', 'error', 'info', 'debug', 'trace']

    methods.forEach((method) => {
      if (!console[method]) return
      this._originalConsole[method] = console[method]
      console[method] = (...args) => {
        try {
          this._buffer.push({
            type: method,
            args: args.map((arg) => this._toSafeString(arg)),
            timestamp: Date.now(),
          })
        } catch {
          // ignore
        }
        this._originalConsole[method].apply(console, args)
      }
    })
  }

  _restoreConsole() {
    Object.keys(this._originalConsole).forEach((method) => {
      console[method] = this._originalConsole[method]
    })
    this._originalConsole = {}
  }

  _toSafeString(arg) {
    if (arg === null) return 'null'
    if (arg === undefined) return 'undefined'
    if (typeof arg === 'string') return arg
    if (typeof arg === 'number' || typeof arg === 'boolean') return arg

    // Handle special objects ที่ JSON.stringify ไม่ได้
    if (arg instanceof File) {
      return {
        __type: 'File',
        name: arg.name,
        size: arg.size,
        type: arg.type,
        lastModified: arg.lastModified,
      }
    }
    if (arg instanceof Blob) {
      return { __type: 'Blob', size: arg.size, type: arg.type }
    }
    if (arg instanceof Error) {
      return { __type: 'Error', message: arg.message, stack: arg.stack }
    }
    if (arg instanceof Map) {
      return { __type: 'Map', size: arg.size, entries: Array.from(arg.entries()) }
    }
    if (arg instanceof Set) {
      return { __type: 'Set', size: arg.size, values: Array.from(arg.values()) }
    }
    if (typeof arg === 'function') {
      return `[Function: ${arg.name || 'anonymous'}]`
    }
    if (arg instanceof Element) {
      return { __type: 'Element', tagName: arg.tagName, id: arg.id, className: arg.className }
    }

    try {
      const seen = new WeakSet()
      return JSON.parse(
        JSON.stringify(arg, (key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]'
            seen.add(value)
            // Handle nested special objects
            if (value instanceof File) {
              return { __type: 'File', name: value.name, size: value.size, type: value.type }
            }
            if (value instanceof Blob) {
              return { __type: 'Blob', size: value.size, type: value.type }
            }
            if (value instanceof Error) {
              return { __type: 'Error', message: value.message }
            }
            if (value instanceof Map) {
              return { __type: 'Map', size: value.size }
            }
            if (value instanceof Set) {
              return { __type: 'Set', size: value.size }
            }
            if (value instanceof Element) {
              return { __type: 'Element', tagName: value.tagName }
            }
          }
          if (typeof value === 'function') return '[Function]'
          return value
        })
      )
    } catch {
      try {
        return String(arg)
      } catch {
        return '[Unserializable]'
      }
    }
  }

  _flush() {
    if (this._buffer.length === 0) return

    const logs = this._buffer
    this._buffer = []

    fetch(this._url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logs),
    })
      .then(() => {
        this._sentCount += logs.length
        this._updateStats()
      })
      .catch(() => {
        // drop logs ถ้าส่งไม่ได้ ไม่ retry เพื่อป้องกัน buffer ล้น
      })
  }

  _updateUI() {
    const $btn = this._$el.find(c('.toggle-btn'))
    const $status = this._$el.find(c('.status'))
    const $input = this._$el.find(c('.url-input'))

    if (this._isRunning) {
      $btn.text('Stop')
      $status.text('Status: Running')
      $input.get(0).disabled = true
    } else {
      $btn.text('Start')
      $status.text('Status: Stopped')
      $input.get(0).disabled = false
    }

    this._updateStats()
  }

  _updateStats() {
    const $stats = this._$el.find(c('.stats'))
    $stats.text(`Logs sent: ${this._sentCount}`)
  }
}
