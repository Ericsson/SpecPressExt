const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { ConfigLoader } = require('./vscode/configLoader')
const { StateManager } = require('./vscode/stateManager')
const { PreviewManager } = require('./vscode/previewManager')
const { exportHtml } = require('./vscode/exportHtml')
const { exportDocx } = require('./vscode/exportDocx')
const { compareDocx } = require('./vscode/compareDocx')
const { NOT_CONFIGURED_MSG, pickCommit } = require('./vscode/helpers')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { JsonTableEditorProvider } = require('./vscode/jsonTableEditor')

const config = new ConfigLoader()
const state = new StateManager()

/** @type {PreviewManager|null} */
let previewMgr = null

/**
 * Activates the extension. Registers all commands and listeners.
 *
 * @param {vscode.ExtensionContext} context - The extension context provided by VSCode.
 */
function activate(context) {
  const extensionDir = path.join(__dirname, '..')
  previewMgr = new PreviewManager(state, config, extensionDir)

  // Register JsonTable custom editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      JsonTableEditorProvider.viewType,
      new JsonTableEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false }
    )
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('specpress.preview', () => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showErrorMessage('Open a markdown or ASN.1 file first')
        return
      }
      const isMarkdown = editor.document.languageId === 'markdown'
      const isAsn = editor.document.fileName.endsWith('.asn')
      if (!isMarkdown && !isAsn) {
        vscode.window.showErrorMessage('Open a markdown or ASN.1 file first')
        return
      }
      if (!config.isInsideSpecRoot(editor.document.uri.fsPath)) {
        vscode.window.showWarningMessage('SpecPress: This file is outside the configured specificationRootPath.')
        return
      }
      state.autoPreviewActive = true
      previewMgr.setupPreview(editor)
    }),

    vscode.commands.registerCommand('specpress.previewMultiple', async (uri, allUris, options) => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        filters: { 'Markdown': ['md', 'markdown', 'asn'] }
      }))

      if (!uris) return

      let commitRef = null
      if (!options || !options.skipCommitPicker) {
        let repoRoot
        try {
          repoRoot = getRepoRoot(fs.statSync(uris[0].fsPath).isDirectory() ? uris[0].fsPath : path.dirname(uris[0].fsPath))
        } catch (e) { /* not a git repo */ }

        if (repoRoot) {
          const picked = await pickCommit(repoRoot, 'Select version for preview', { localFilesOption: true })
          if (picked === null) return
          if (picked) {
            try {
              const shortHash = execSync(`git rev-parse --short ${picked}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
              commitRef = { repoRoot, commit: picked, shortHash }
            } catch (e) {
              vscode.window.showErrorMessage(`Invalid commit reference: ${picked}`)
              return
            }
          }
        }
      }

      await previewMgr.previewMultiple(uris, commitRef)
    }),

    vscode.commands.registerCommand('specpress.exportSelectedAsDocx', async (uri, allUris) => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        filters: { 'Markdown': ['md', 'markdown', 'asn'] }
      }))
      if (!uris) return

      await exportDocx(state, config, context, uri, uris)
    }),

    vscode.commands.registerCommand('specpress.compareDocx', async (uri, allUris) => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      await compareDocx(state, config, context, uri, allUris)
    }),

    vscode.commands.registerCommand('specpress.exportHtml', async () => {
      await exportHtml(state, config, previewMgr)
    }),

    vscode.commands.registerCommand('specpress.editSection', () => {
      if (!state.lastContextTarget) return
      const filePath = state.lastContextTarget.file || (state.currentEditor && state.currentEditor.document.uri.fsPath)
      if (!filePath) return
      const line = state.lastContextTarget.line || 0
      vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(doc => {
        vscode.window.showTextDocument(doc, vscode.ViewColumn.One).then(editor => {
          const pos = new vscode.Position(line, 0)
          editor.selection = new vscode.Selection(pos, pos)
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
        })
      })
    }),

    vscode.commands.registerCommand('specpress.openJsonTableEditor', async (uri) => {
      await JsonTableEditorProvider.openEditor(vscode, uri)
    }),

    vscode.commands.registerCommand('specpress.openOrCreateJsonTable', async () => {
      await JsonTableEditorProvider.openOrCreate(vscode)
    }),

    vscode.commands.registerCommand('specpress.toggleChangeTracking', async () => {
      let repoRoot
      const specRoots = config.resolveSpecRoots()
      const searchPath = specRoots.length > 0 ? specRoots[0] : (config.wsRoot || '')
      try {
        repoRoot = getRepoRoot(searchPath)
      } catch (e) {
        vscode.window.showErrorMessage('Change tracking requires a git repository.')
        return
      }

      const baselineCommit = await pickCommit(repoRoot, 'Select baseline commit for change tracking')
      if (!baselineCommit) return

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading baseline for change tracking...' },
        async () => {
          const searchPaths = specRoots.length > 0 ? specRoots : [config.wsRoot]
          const baselineCache = new Map()

          for (const p of searchPaths) {
            const rel = path.relative(repoRoot, p).replace(/\\/g, '/')
            const prefix = rel ? rel + '/' : ''
            try {
              const tar = execSync(`git archive ${baselineCommit} -- "${prefix}"`, {
                cwd: repoRoot, maxBuffer: 50 * 1024 * 1024
              })
              // Parse tar to extract file contents
              let offset = 0
              while (offset < tar.length - 512) {
                const header = tar.slice(offset, offset + 512)
                const name = header.slice(0, 100).toString().replace(/\0/g, '').trim()
                if (!name) break
                const sizeStr = header.slice(124, 136).toString().replace(/\0/g, '').trim()
                const size = parseInt(sizeStr, 8) || 0
                offset += 512
                if (size > 0 && /\.(md|markdown|asn|json|png|jpg|jpeg|gif|bmp|svg)$/.test(name)) {
                  const isImage = /\.(png|jpg|jpeg|gif|bmp|svg)$/.test(name)
                  const content = isImage
                    ? tar.slice(offset, offset + size) // keep as Buffer for binary
                    : tar.slice(offset, offset + size).toString('utf8')
                  baselineCache.set(path.join(repoRoot, name), content)
                }
                offset += Math.ceil(size / 512) * 512
              }
            } catch (e) { /* path may not exist in baseline */ }
          }

          state.changeTrackingCommit = baselineCommit
          state.changeTrackingRepoRoot = repoRoot
          state.changeTrackingBaseline = baselineCache
          vscode.commands.executeCommand('setContext', 'specpress.changeTrackingActive', true)

          let shortHash
          try { shortHash = execSync(`git rev-parse --short ${baselineCommit}`, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch (e) { shortHash = baselineCommit.substring(0, 7) }
          vscode.window.showInformationMessage(`SpecPress: Change tracking enabled (baseline: ${shortHash}, ${baselineCache.size} files cached).`)
        }
      )

      // Refresh current preview with diff
      if (state.panel && state.currentEditor) {
        previewMgr.setupPreview(state.currentEditor)
      } else if (state.panel && state.lastMultiFileUris) {
        await previewMgr.previewMultiple(state.lastMultiFileUris, null)
      }
    }),

    vscode.commands.registerCommand('specpress.disableChangeTracking', async () => {
      state.changeTrackingCommit = null
      state.changeTrackingRepoRoot = null
      state.changeTrackingBaseline = null
      vscode.commands.executeCommand('setContext', 'specpress.changeTrackingActive', false)
      vscode.window.showInformationMessage('SpecPress: Change tracking disabled.')
      // Refresh current preview without diff
      if (state.panel && state.currentEditor) {
        previewMgr.setupPreview(state.currentEditor)
      } else if (state.panel && state.lastMultiFileUris) {
        await previewMgr.previewMultiple(state.lastMultiFileUris, null)
      }
    }),

    vscode.commands.registerCommand('specpress.restoreMultiPreview', () => {
      let uris = state.lastMultiFileUris
      if (!uris) {
        const defaultPath = config.multiPagePreviewDefaultPath
        if (!defaultPath) {
          vscode.window.showErrorMessage('No previous multi-file preview to restore.')
          return
        }
        const abs = path.isAbsolute(defaultPath) ? defaultPath
          : config.wsRoot ? path.join(config.wsRoot, defaultPath)
          : defaultPath
        uris = [vscode.Uri.file(abs)]
      }
      const editor = vscode.window.activeTextEditor
      if (editor) {
        const visibleLine = editor.visibleRanges[0]?.start.line || 0
        state.restoreScrollTarget = { file: editor.document.uri.fsPath, line: visibleLine }
      }
      vscode.commands.executeCommand('specpress.previewMultiple', uris[0], uris, { skipCommitPicker: true })
    })
  )

  // Auto preview when switching editors
  let hintShown = false
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return
      if (state.autoPreviewActive) {
        if (config.resolveSpecRoots().length) previewMgr.setupPreview(editor)
        return
      }
      if (!hintShown && !state.panel && config.resolveSpecRoots().length) {
        const isSpec = (editor.document.languageId === 'markdown' || editor.document.fileName.endsWith('.asn'))
          && config.isInsideSpecRoot(editor.document.uri.fsPath)
        if (isSpec) {
          hintShown = true
          vscode.window.showInformationMessage(
            'SpecPress: Right-click the file in the explorer and choose "SpecPress: Open Preview" to activate the live preview.',
            'Open Preview'
          ).then(choice => {
            if (choice === 'Open Preview') {
              state.autoPreviewActive = true
              const ed = vscode.window.activeTextEditor
              if (ed) previewMgr.setupPreview(ed)
            }
          })
        }
      }
    })
  )

  // Re-initialize handler when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('specpress')) {
        config.invalidate()
        state.handler = null
      }
    })
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
