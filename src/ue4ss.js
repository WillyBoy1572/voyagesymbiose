'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  UE4SS — installation depuis l'archive livrée avec le lanceur
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ L'ARCHIVE EST EMBARQUÉE, ELLE N'EST PAS TÉLÉCHARGÉE. Le jeu tourne sur
 *     Unreal 5.8, que seules les compilations expérimentales d'UE4SS
 *     supportent — la v3.0.1 « stable » date de février 2024 et ne le connaît
 *     pas. Or ces compilations sont publiées sous un tag roulant dont
 *     l'archive est remplacée régulièrement : aller la chercher voudrait dire
 *     que chaque joueur reçoit une version différente, jamais testée, et
 *     qu'un mod qui marchait hier casse aujourd'hui sans qu'on ait rien
 *     changé.
 *
 *  ⚠️ L'EMPREINTE EST VÉRIFIÉE AVANT D'OUVRIR L'ARCHIVE. Elle vit dans le
 *     dossier d'installation, où n'importe quoi peut la remplacer. On refuse
 *     plutôt que de copier un fichier inconnu dans le dossier d'un jeu.
 *
 *  UE4SS est publié sous licence MIT ; sa notice accompagne l'archive dans
 *  `ressources/ue4ss/LICENSE-UE4SS.txt`.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ARCHIVE = 'UE4SS_v3.0.1-1152-ge3ba1016.zip'
const EMPREINTE = 'af8ea9d8975e8eff7967423f43b8b50875e66a29a0f434cffce6e0867ea17252'
const VERSION = 'v3.0.1-1152-ge3ba1016'

/** On renvoie une clé, la page traduit. */
function souci(cle, message, valeurs) {
  return Object.assign(new Error(message), { cle, valeurs })
}

/**
 * Chemin réel de l'archive.
 *
 * ⚠️ POWERSHELL NE SAIT PAS LIRE DANS `app.asar`. Node y accède de façon
 *    transparente, pas un programme externe : il faut lui donner le chemin
 *    déballé, d'où la réécriture vers `app.asar.unpacked`.
 */
function cheminArchive() {
  const dansAsar = path.join(__dirname, '..', 'ressources', 'ue4ss', ARCHIVE)
  const dehors = dansAsar.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  if (fs.existsSync(dehors)) return dehors
  if (fs.existsSync(dansAsar)) return dansAsar
  return null
}

function empreinteDe(chemin) {
  return crypto.createHash('sha256').update(fs.readFileSync(chemin)).digest('hex')
}

function extraire(archive, cible) {
  return new Promise((resolve, rejeter) => {
    fs.mkdirSync(cible, { recursive: true })
    /*
      ⚠️ PAS DE BIBLIOTHÈQUE DE DÉCOMPRESSION. Windows sait le faire seul :
         `Expand-Archive` est présent depuis PowerShell 5, livré d'origine.
         Une dépendance de moins à auditer dans un outil qui écrit dans le
         dossier d'un jeu.
    */
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${cible.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true, timeout: 180000 },
      (err) => {
        if (!err) return resolve(cible)
        // Repli : `tar` est livré avec Windows 10 et sait lire un zip.
        execFile('tar', ['-xf', archive, '-C', cible], { windowsHide: true, timeout: 180000 }, (err2) =>
          err2 ? rejeter(souci('err.extraction', 'Impossible d’extraire l’archive UE4SS.')) : resolve(cible),
        )
      },
    )
  })
}

/**
 * Cherche, dans l'arborescence extraite, le dossier qui contient vraiment
 * UE4SS — l'archive peut envelopper son contenu dans un sous-dossier.
 */
function racineUe4ss(depart, profondeur = 0) {
  if (fs.existsSync(path.join(depart, 'dwmapi.dll')) && fs.existsSync(path.join(depart, 'ue4ss'))) {
    return depart
  }
  if (profondeur > 3) return null
  for (const e of fs.readdirSync(depart, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const trouve = racineUe4ss(path.join(depart, e.name), profondeur + 1)
    if (trouve) return trouve
  }
  return null
}

/** Ce que le lanceur embarque, pour l'afficher sans rien ouvrir. */
function archiveLivree() {
  const chemin = cheminArchive()
  return { nom: ARCHIVE, version: VERSION, present: Boolean(chemin), chemin }
}

/**
 * Prépare UE4SS dans un dossier de travail et rend son emplacement.
 * `surAvancement(fait, total)` suit l'extraction.
 */
async function preparer(dossierTravail, surAvancement = () => {}) {
  const source = cheminArchive()
  if (!source) {
    throw souci('err.archiveAbsente', 'L’archive UE4SS livrée avec le lanceur est introuvable.')
  }

  if (empreinteDe(source) !== EMPREINTE) {
    throw souci('err.archiveAlteree', 'L’archive UE4SS livrée ne correspond pas à son empreinte.')
  }

  const dossier = path.join(dossierTravail, 'ue4ss')
  fs.rmSync(dossier, { recursive: true, force: true })
  fs.mkdirSync(dossier, { recursive: true })

  const total = fs.statSync(source).size
  surAvancement(0, total)
  const extrait = path.join(dossier, 'extrait')
  await extraire(source, extrait)
  surAvancement(total, total)

  const racine = racineUe4ss(extrait)
  if (!racine) throw souci('err.archivePasUe4ss', 'L’archive livrée ne ressemble pas à UE4SS.')

  return { dossier: racine, version: VERSION, nom: ARCHIVE }
}

module.exports = {
  preparer,
  // Le nom d'origine reste exposé : l'interface et le processus principal
  // l'appellent déjà, et pour eux rien ne change.
  telecharger: preparer,
  archiveLivree,
  dossierTemporaire: () => path.join(os.tmpdir(), 'voyage-lanceur'),
}
