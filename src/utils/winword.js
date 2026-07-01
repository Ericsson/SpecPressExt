/**
 * Detects the path to winword.exe via the Windows registry.
 * Returns the path if found and the file exists, or null otherwise.
 */
function findWinword() {
  if (process.platform !== 'win32') return null
  try {
    const result = require('child_process').execSync(
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Winword.exe" /ve',
      { encoding: 'utf8' }
    )
    const match = result.match(/REG_SZ\s+(.+)/)
    const p = match ? match[1].trim() : null
    return (p && require('fs').existsSync(p)) ? p : null
  } catch (e) {
    return null
  }
}

module.exports = { findWinword }
