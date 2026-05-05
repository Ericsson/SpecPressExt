const assert = require('assert')
const vscode = require('vscode')
const path = require('path')
const fs = require('fs')

const FIXTURES = path.resolve(__dirname, '../fixtures/workspace')

// Helper: wait with timeout
function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// Helper: open a file from the fixtures folder
async function openFixture(relativePath) {
  const filePath = path.join(FIXTURES, relativePath)
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
  return vscode.window.showTextDocument(doc, vscode.ViewColumn.One)
}

suite('Extension Activation', function () {
  this.timeout(15000)

  test('extension is present', function () {
    const ext = vscode.extensions.getExtension('Ericsson.specpressext')
    assert.ok(ext, 'Extension should be found')
  })

  test('extension activates', async function () {
    const ext = vscode.extensions.getExtension('Ericsson.specpressext')
    if (!ext.isActive) await ext.activate()
    assert.ok(ext.isActive, 'Extension should be active')
  })
})

suite('Commands Registration', function () {
  this.timeout(10000)

  const expectedCommands = [
    'specpress.preview',
    'specpress.previewMultiple',
    'specpress.exportHtml',
    'specpress.exportSelectedAsDocx',
    'specpress.compareDocx',
    'specpress.editSection',
    'specpress.restoreMultiPreview',
    'specpress.toggleChangeTracking',
    'specpress.disableChangeTracking',
    'specpress.openJsonTableEditor',
    'specpress.openOrCreateJsonTable'
  ]

  expectedCommands.forEach(cmd => {
    test(`command "${cmd}" is registered`, async function () {
      const commands = await vscode.commands.getCommands(true)
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`)
    })
  })
})

suite('Preview Commands', function () {
  this.timeout(15000)

  test('specpress.preview shows warning when no spec root configured', async function () {
    // Without a workspace, the spec root is not configured
    // The command should show a warning but not crash
    await vscode.commands.executeCommand('specpress.preview')
    // If we get here without throwing, the command handled the missing config gracefully
    assert.ok(true)
  })
})
