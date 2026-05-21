const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * Simple file logger for debugging
 */
class Logger {
  constructor() {
    this.logPath = path.join(os.tmpdir(), 'specpress-debug.log')
    this.enabled = false
  }

  setEnabled(enabled) {
    this.enabled = enabled
    if (enabled) {
      this.clear()
    }
  }

  clear() {
    if (!this.enabled) return
    try {
      fs.writeFileSync(this.logPath, `=== SpecPress Debug Log ===\n${new Date().toISOString()}\n\n`)
    } catch (e) {
      // Ignore
    }
  }

  log(message, data = null) {
    if (!this.enabled) return
    try {
      const timestamp = new Date().toISOString()
      let logLine = `[${timestamp}] ${message}`
      if (data !== null) {
        logLine += `\n  Data: ${JSON.stringify(data, null, 2)}`
      }
      logLine += '\n'
      fs.appendFileSync(this.logPath, logLine)
    } catch (e) {
      // Ignore
    }
  }

  getLogPath() {
    return this.logPath
  }
}

const logger = new Logger()

module.exports = { logger }
