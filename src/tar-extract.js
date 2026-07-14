'use strict';
const { execSync } = require('child_process');

// Windows tiene DOS tars posibles corriendo `tar`:
//  - GNU tar (Git Bash / MSYS): interpreta "C:/Users/..." como host remoto
//    salvo que se le pase --force-local.
//  - bsdtar nativo de Windows 10/11 (libarchive): NO tiene esa interpretación
//    de host remoto, y además no reconoce la opción --force-local — falla con
//    "tar: Option --force-local is not supported" si se la pasamos.
// Por eso probamos primero con --force-local (necesario en Git Bash) y si
// falla por opción no reconocida, reintentamos sin ella (bsdtar nativo).
function extractTarGz(tarFile, destDir) {
  const tarFileForTar = tarFile.replace(/\\/g, '/');
  const destDirForTar = destDir.replace(/\\/g, '/');
  const baseArgs = `-xzf "${tarFileForTar}" -C "${destDirForTar}" --strip-components=1`;
  try {
    execSync(`tar --force-local ${baseArgs}`, { stdio: 'pipe' });
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString();
    if (/force-local/i.test(msg)) {
      execSync(`tar ${baseArgs}`, { stdio: 'pipe' });
    } else {
      throw err;
    }
  }
}

module.exports = { extractTarGz };
