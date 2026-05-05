const path = require('path')
const Mocha = require('mocha')
const fs = require('fs')

function run() {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000 })
  const testsRoot = path.resolve(__dirname)

  return new Promise((resolve, reject) => {
    const files = fs.readdirSync(testsRoot).filter(f => f.endsWith('.test.js'))
    files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)))

    mocha.run(failures => {
      if (failures > 0) reject(new Error(`${failures} test(s) failed`))
      else resolve()
    })
  })
}

module.exports = { run }
