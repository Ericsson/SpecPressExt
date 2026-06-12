const vscode = require('vscode')
const path = require('path')
const fs = require('fs')

class BcTreeItem extends vscode.TreeItem {
  constructor(label, collapsibleState, bc, itemType) {
    super(label, collapsibleState)
    this.bc = bc
    this.itemType = itemType
  }
}

class BcTreeProvider {
  constructor(config, bcPreviewManager) {
    this.config = config
    this.bcPreviewManager = bcPreviewManager
    this._onDidChangeTreeData = new vscode.EventEmitter()
    this.onDidChangeTreeData = this._onDidChangeTreeData.event
    this.bcFiles = []
    this.filterBcId = ''
    this.filterBands = [] // Array of band numbers
    this.filterBandsMode = 'atLeast' // 'only' or 'atLeast'
    this.filterCarriers = ''
    this.filterCarriersMode = 'exactly' // 'exactly', 'atLeast', or 'upTo'
    this.filterProperties = [] // Array of property names: 'intraBand', 'fr1', 'fr2', 'nr', 'sul'
    this.filterModifiedOnly = false // Show only git-modified files
    this.filterUlNotes = [] // Array of UL note keys
    this.filterDlNotes = [] // Array of DL note keys
    this.modifiedFilesCache = null // Cached set of modified file paths
    // Type filters (what to load)
    this.loadCA = true
    this.loadDC = false
    this.loadBands = true
    this.treeView = null // Will be set from extension.js
  }

  refresh() {
    this.loadBcFiles()
    // Invalidate modified files cache on refresh
    this.modifiedFilesCache = null
    this._onDidChangeTreeData.fire()
    this.updateTreeTitle()
  }

  async setFilters(bcId, bands, bandsMode, carriers, carriersMode, properties, modifiedOnly, ulNotes, dlNotes) {
    this.filterBcId = (bcId || '').toLowerCase()
    this.filterBands = bands || []
    this.filterBandsMode = bandsMode || 'atLeast'
    this.filterCarriers = carriers || ''
    this.filterCarriersMode = carriersMode || 'exactly'
    this.filterProperties = properties || []
    this.filterModifiedOnly = modifiedOnly || false
    this.filterUlNotes = ulNotes || []
    this.filterDlNotes = dlNotes || []
    this.refresh()
  }

  updateTreeTitle() {
    if (this.treeView && this.currentFilteredFiles !== undefined) {
      this.treeView.description = `(${this.currentFilteredFiles.length})`
    }
  }

  setTypeFilters(loadCA, loadDC, loadBands) {
    this.loadCA = loadCA
    this.loadDC = loadDC
    this.loadBands = loadBands
    this.refresh()
  }

  async applyFilters(files) {
    let BC_ID = null
    try {
      const mod = await import('ran4-jsvalidator/src/BC_ID.js')
      BC_ID = mod.BC_ID
    } catch (e) {
      // jsvalidator not available, use simple heuristic
    }

    // Get modified files from git if needed
    let modifiedFiles = null
    if (this.filterModifiedOnly) {
      if (!this.modifiedFilesCache) {
        this.modifiedFilesCache = await this.getModifiedFiles()
      }
      modifiedFiles = this.modifiedFilesCache
    }

    return files.filter(bc => {
      // Filter by git modified status
      if (this.filterModifiedOnly && modifiedFiles) {
        const normalizedPath = bc.path.toLowerCase().replace(/\\/g, '/')
        if (!modifiedFiles.has(normalizedPath)) {
          return false
        }
      }
      
      // Filter by BC ID (exact match)
      if (this.filterBcId && bc.bcId.toLowerCase() !== this.filterBcId) {
        return false
      }
      
      // Filter by band numbers
      if (this.filterBands.length > 0) {
        const bandNumbers = this.extractBandNumbers(bc.bcId)
        
        if (this.filterBandsMode === 'only') {
          // Only mode: BC must contain exactly these bands
          if (bandNumbers.length !== this.filterBands.length) {
            return false
          }
          if (!this.filterBands.every(fb => bandNumbers.includes(fb))) {
            return false
          }
        } else {
          // At least mode: BC must contain all these bands (and possibly more)
          if (!this.filterBands.every(fb => bandNumbers.includes(fb))) {
            return false
          }
        }
      }
      
      // Filter by number of carriers
      if (this.filterCarriers) {
        const targetCount = parseInt(this.filterCarriers)
        const carrierCount = BC_ID 
          ? this.getCarrierCountUsingBcId(bc.bcId, BC_ID)
          : this.extractCarrierCountHeuristic(bc.bcId)
        
        if (this.filterCarriersMode === 'exactly') {
          if (carrierCount !== targetCount) return false
        } else if (this.filterCarriersMode === 'atLeast') {
          if (carrierCount < targetCount) return false
        } else if (this.filterCarriersMode === 'upTo') {
          if (carrierCount > targetCount) return false
        }
      }
      
      // Filter by properties (using BC_ID methods)
      if (this.filterProperties.length > 0 && BC_ID) {
        try {
          const bcIdObj = new BC_ID(bc.bcId)
          
          for (const prop of this.filterProperties) {
            let matches = false
            
            if (prop === 'intraBand' && bcIdObj.isIntraBand()) matches = true
            else if (prop === 'fr1' && bcIdObj.isFr1()) matches = true
            else if (prop === 'fr2' && bcIdObj.isFr2()) matches = true
            else if (prop === 'nr' && bcIdObj.isNR()) matches = true
            else if (prop === 'sul' && bcIdObj.isSUL()) matches = true
            
            if (!matches) return false
          }
        } catch (e) {
          // If BC_ID parsing fails, exclude this item when properties are filtered
          return false
        }
      }
      
      // Filter by UL notes
      if (this.filterUlNotes.length > 0 && bc.data && bc.data.bcsList) {
        let hasAnyUlNote = false
        for (const bcs of bc.data.bcsList) {
          if (bcs.ulConfigList) {
            for (const ulConfig of bcs.ulConfigList) {
              if (ulConfig.notes) {
                for (const noteKey of this.filterUlNotes) {
                  if (ulConfig.notes[noteKey] === true) {
                    hasAnyUlNote = true
                    break
                  }
                }
              }
              if (hasAnyUlNote) break
            }
          }
          if (hasAnyUlNote) break
        }
        if (!hasAnyUlNote) return false
      }
      
      // Filter by DL notes (BC-level notes)
      if (this.filterDlNotes.length > 0) {
        if (!bc.data || !bc.data.notes) {
          return false
        }
        let hasAnyDlNote = false
        for (const noteKey of this.filterDlNotes) {
          if (bc.data.notes[noteKey] === true) {
            hasAnyDlNote = true
            break
          }
        }
        if (!hasAnyDlNote) return false
      }
      
      return true
    })
  }

  getCarrierCountUsingBcId(bcId, BC_ID) {
    // Use BC_ID.getNrofCarriers() for accurate carrier count
    try {
      const bcIdObj = new BC_ID(bcId)
      return bcIdObj.getNrofCarriers()
    } catch (e) {
      // If parsing fails, fall back to heuristic
      return this.extractCarrierCountHeuristic(bcId)
    }
  }

  extractCarrierCountHeuristic(bcId) {
    // Fallback heuristic: count uppercase BWC letters
    const matches = bcId.match(/[A-Z](?![a-z])/g)
    return matches ? matches.length : 0
  }

  extractBandNumbers(bcId) {
    // Extract band numbers from BC-ID (e.g., "CA_n1A-n78C" -> ["n1", "n78"])
    const matches = bcId.match(/n\d+/g)
    return matches || []
  }

  async getModifiedFiles() {
    const { execSync } = require('child_process')
    const modifiedFiles = new Set()
    
    const bcFolder = this.config.raw.get('bandCombinationFolder', '')
    if (!bcFolder) return modifiedFiles
    
    const absFolder = path.isAbsolute(bcFolder) 
      ? bcFolder 
      : this.config.wsRoot ? path.join(this.config.wsRoot, bcFolder) : bcFolder
    
    // Find all git repos under the BC folder
    const gitRepos = this.findGitRepos(absFolder)
    
    // Get modified files from each repo
    for (const gitRoot of gitRepos) {
      try {
        const output = execSync('git status --porcelain', { 
          cwd: gitRoot, 
          encoding: 'utf8' 
        })
        
        const lines = output.split('\n').filter(line => line.trim())
        
        for (const line of lines) {
          if (line.length < 4) continue
          
          const status = line.substring(0, 2)
          let filename = line.substring(3).trim()
          
          if (filename.startsWith('"') && filename.endsWith('"')) {
            filename = filename.slice(1, -1)
          }
          
          // Only modified/added/untracked JSON files
          if ((status.includes('M') || status.includes('A') || status.includes('?')) && filename.endsWith('.json')) {
            const fullPath = path.resolve(gitRoot, filename).toLowerCase().replace(/\\/g, '/')
            modifiedFiles.add(fullPath)
          }
        }
      } catch (e) {
        // Silently skip git repos with errors
      }
    }
    
    return modifiedFiles
  }

  findGitRepos(rootPath) {
    const repos = []
    
    const scanDir = (dir, depth = 0) => {
      if (depth > 3) return // Don't scan too deep
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        
        // Check if this directory is a git repo
        if (entries.some(e => e.isDirectory() && e.name === '.git')) {
          repos.push(dir)
          return // Don't scan subdirectories of a git repo
        }
        
        // Recursively scan subdirectories
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
            scanDir(path.join(dir, entry.name), depth + 1)
          }
        }
      } catch (e) {
        // Skip inaccessible directories
      }
    }
    
    scanDir(rootPath)
    return repos
  }

  loadBcFiles() {
    this.bcFiles = []
    const bcFolder = this.config.raw.get('bandCombinationFolder', '')
    if (!bcFolder) return

    const absFolder = path.isAbsolute(bcFolder) 
      ? bcFolder 
      : this.config.wsRoot ? path.join(this.config.wsRoot, bcFolder) : bcFolder

    if (!fs.existsSync(absFolder)) return

    // Scan for CA_*.json and DC_*.json files
    this.scanForBcFiles(absFolder)
  }

  scanForBcFiles(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          this.scanForBcFiles(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          // Check if we should load this file based on type filters
          const isDC = entry.name.startsWith('DC_')
          const isCA = entry.name.startsWith('CA_')
          const isBand = entry.name.match(/^n\d+\.json$/)
          
          // Skip if type is disabled
          if (isDC && !this.loadDC) continue
          if (isCA && !this.loadCA) continue
          if (isBand && !this.loadBands) continue
          
          // Only load CA_*, DC_*, or band files (n*.json)
          if (isCA || isDC || isBand) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8')
              const data = JSON.parse(content)
              // For band files, bcId might be in the data or derive from filename
              const bcId = data.bcId || (isBand ? entry.name.replace('.json', '') : null)
              if (bcId) {
                this.bcFiles.push({ 
                  path: fullPath, 
                  bcId: bcId, 
                  data,
                  isBand: !!isBand,
                  isCA: !!isCA,
                  isDC: !!isDC
                })
              }
            } catch (e) {
              // Skip invalid JSON files
            }
          }
        }
      }
    } catch (e) {
      // Skip inaccessible directories
    }
  }

  getTreeItem(element) {
    return element
  }

  getAllBands() {
    // Get unique list of all bands from loaded BC files
    const bands = new Set()
    this.bcFiles.forEach(bc => {
      const bandNumbers = this.extractBandNumbers(bc.bcId)
      bandNumbers.forEach(b => bands.add(b))
    })
    return Array.from(bands).sort()
  }

  async getChildren(element) {
    if (!element) {
      const bcFolder = this.config.raw.get('bandCombinationFolder', '')
      
      if (!bcFolder) {
        // Show configuration hint
        const item = new BcTreeItem(
          'Configuration Required',
          vscode.TreeItemCollapsibleState.None,
          null,
          'hint'
        )
        item.description = 'Click to configure'
        item.tooltip = 'The bandCombinationFolder setting must be configured'
        item.iconPath = new vscode.ThemeIcon('info')
        item.command = {
          command: 'specpress.configureBcFolder',
          title: 'Configure Band Combination Folder'
        }
        return [item]
      }
      
      if (this.bcFiles.length === 0) {
        this.loadBcFiles()
      }
      
      if (this.bcFiles.length === 0) {
        // Show empty state
        const item = new BcTreeItem(
          'No Band Combinations Found',
          vscode.TreeItemCollapsibleState.None,
          null,
          'empty'
        )
        item.description = ''
        item.tooltip = `No CA_*.json or DC_*.json files found in ${bcFolder}`
        item.iconPath = new vscode.ThemeIcon('search')
        return [item]
      }
      
      // Sort using BC_ID comparison
      const filteredFiles = await this.applyFilters(this.bcFiles)
      this.currentFilteredFiles = filteredFiles
      const sortedFiles = await this.sortBcFiles(filteredFiles)
      
      // Update tree title with count
      this.updateTreeTitle()
      
      return sortedFiles.map(bc => {
        const item = new BcTreeItem(
          bc.bcId,
          vscode.TreeItemCollapsibleState.None,
          bc,
          'bc'
        )
        item.description = path.basename(bc.path)
        item.tooltip = bc.path
        // Different icon for band files vs CA/DC configurations
        item.iconPath = bc.isBand 
          ? new vscode.ThemeIcon('symbol-constant') 
          : new vscode.ThemeIcon('symbol-file')
        item.command = {
          command: 'specpress.openBcPreview',
          title: 'Open BC Preview',
          arguments: [bc.path]
        }
        return item
      })
    }
    return []
  }

  getFilteredFiles() {
    return this.currentFilteredFiles || []
  }

  async sortBcFiles(files) {
    try {
      // Import BC_ID for proper sorting
      const { BC_ID } = await import('ran4-jsvalidator/src/BC_ID.js')
      
      return files.slice().sort((a, b) => {
        try {
          const bcIdA = new BC_ID(a.bcId)
          const bcIdB = new BC_ID(b.bcId)
          
          if (bcIdA.lessThan(bcIdB)) return -1
          if (bcIdA.greaterThan(bcIdB)) return 1
          return 0
        } catch (e) {
          // Fallback to string comparison if BC_ID parsing fails
          return a.bcId.localeCompare(b.bcId)
        }
      })
    } catch (e) {
      // If jsvalidator import fails, fallback to simple string sort
      return files.slice().sort((a, b) => a.bcId.localeCompare(b.bcId))
    }
  }
}

module.exports = { BcTreeProvider }
