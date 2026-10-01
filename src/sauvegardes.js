'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const { execFile } = require('node:child_process')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LES SAUVEGARDES DU JEU, CHEZ LE JOUEUR
 * ═══════════════════════════════════════════════════════════════════════════
 *  Publier son monde, regarder ce qu'un autre a publie, l'installer, et
 *  pouvoir revenir en arriere.
 *
 *  ⚠️ ON SAUVEGARDE AVANT D'INSTALLER, TOUJOURS. Installer le monde d'un
 *     hote ECRASE la partie solo du joueur. Sans copie prealable, une seule
 *     mauvaise manipulation detruit des dizaines d'heures de jeu. La copie
 *     n'est pas une option offerte : elle est faite, point.
 *
 *  ⚠️ ON N'EXTRAIT JAMAIS UNE ARCHIVE DIRECTEMENT DANS LE DOSSIER DU JEU.
 *     Une archive peut contenir `..\..\Windows\quelque-chose` : c'est la
 *     faille « zip slip ». On ouvre dans un dossier temporaire, on VERIFIE
 *     chaque nom, puis on copie seulement ce qui passe.
 *
 *  ⚠️ ON NE DECIDE PAS DE L'EMPREINTE. Le serveur calcule la sienne sur ce
 *     qu'il a recu ; on recalcule la notre sur ce qu'on a telecharge, et on
 *     compare. Une empreinte fournie par celui qui envoie ne verifie rien.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on accepte de poser dans le dossier de sauvegardes du jeu. */
const EXTENSIONS = new Set(['.sav', '.json', '.dat', '.bak', '.cfg'])
/** Un nom de fichier sain : ni separateur, ni `..`, ni caractere exotique. */
const NOM_SAIN = /^[A-Za-z0-9 _.\-()]+$/
const TAILLE_MAX = 256 * 1024 * 1024

// ── Trouver les sauvegardes ─────────────────────────────────────────────────

/**
 * Le dossier de sauvegardes du jeu.
 *
 * ⚠️ IL N'EST PAS DANS LE DOSSIER DU JEU. Unreal ecrit dans le profil de
 *    l'utilisateur : chercher a cote de l'executable ne trouve jamais rien.
 */
function dossierSauvegardes(remplacant) {
  if (remplacant && fs.existsSync(remplacant)) return remplacant
  const local = process.env.LOCALAPPDATA
  if (!local) return null
  const d = path.join(local, 'Voyage', 'Saved', 'SaveGames')
  return fs.existsSync(d) ? d : null
}

function empreinteFichier(chemin) {
  return crypto.createHash('sha256').update(fs.readFileSync(chemin)).digest('hex')
}

/** Ce qu'il y a dans un dossier de sauvegardes, a plat. */
function lister(dossier) {
  if (!dossier || !fs.existsSync(dossier)) return []
  const sortie = []
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (!e.isFile()) continue
    const chemin = path.join(dossier, e.name)
    const stat = fs.statSync(chemin)
    sortie.push({
      nom: e.name,
      taille: stat.size,
      modifie: stat.mtime.toISOString(),
      empreinte: stat.size < 64 * 1024 * 1024 ? empreinteFichier(chemin) : null,
    })
  }
  return sortie.sort((a, b) => a.nom.localeCompare(b.nom))
}

// ── Archives, sans dependance ───────────────────────────────────────────────

function powershell(commande, delai = 180000) {
  return new Promise((resolve, rejeter) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', commande],
      { windowsHide: true, timeout: delai, maxBuffer: 8 * 1024 * 1024 },
      (err, sortie) => (err ? rejeter(new Error(err.message.split('\n')[0])) : resolve(String(sortie))),
    )
  })
}

const echappe = (p) => String(p).replace(/'/g, "''")

async function compresser(dossier, cible) {
  fs.rmSync(cible, { force: true })
  await powershell(`Compress-Archive -Path '${echappe(dossier)}\\*' -DestinationPath '${echappe(cible)}' -Force`)
  if (!fs.existsSync(cible)) throw new Error('l’archive n’a pas été créée')
  return cible
}

/** Les noms contenus dans une archive, sans l'extraire. */
async function contenu(archive) {
  const sortie = await powershell(
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `$z=[System.IO.Compression.ZipFile]::OpenRead('${echappe(archive)}'); ` +
      `$z.Entries | ForEach-Object { $_.FullName + '|' + $_.Length }; $z.Dispose()`,
  )
  return sortie
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [nom, taille] = l.split('|')
      return { nom, taille: Number.parseInt(taille, 10) || 0 }
    })
}

async function decompresser(archive, cible) {
  fs.rmSync(cible, { recursive: true, force: true })
  fs.mkdirSync(cible, { recursive: true })
  await powershell(`Expand-Archive -LiteralPath '${echappe(archive)}' -DestinationPath '${echappe(cible)}' -Force`)
  return cible
}

/**
 * Un nom d'archive est-il sur a poser dans le dossier de sauvegardes ?
 *
 * ⚠️ C'EST ICI QU'ON ARRETE « ZIP SLIP ». On refuse les chemins absolus, les
 *    `..`, les separateurs inattendus et tout ce qui n'est pas une
 *    sauvegarde. Le reste du code peut alors faire confiance au nom.
 */
function nomAcceptable(nom) {
  if (!nom || nom.length > 200) return false
  if (nom.endsWith('/') || nom.endsWith('\\')) return false
  if (path.isAbsolute(nom) || /^[A-Za-z]:/.test(nom)) return false

  const morceaux = nom.split(/[/\\]/)
  if (morceaux.length > 2) return false
  for (const m of morceaux) {
    if (!m || m === '.' || m === '..' || !NOM_SAIN.test(m)) return false
  }
  return EXTENSIONS.has(path.extname(morceaux[morceaux.length - 1]).toLowerCase())
}

// ── Reseau ──────────────────────────────────────────────────────────────────

function requete(url, options = {}, corps = null) {
  return new Promise((resolve, rejeter) => {
    const u = new URL(url)
    const client = u.protocol === 'https:' ? https : http
    const r = client.request(u, { timeout: 60000, ...options }, (reponse) => {
      const morceaux = []
      let total = 0
      reponse.on('data', (m) => {
        total += m.length
        if (total > TAILLE_MAX) {
          reponse.destroy()
          rejeter(new Error('réponse trop grosse'))
          return
        }
        morceaux.push(m)
      })
      reponse.on('end', () => resolve({ code: reponse.statusCode ?? 0, corps: Buffer.concat(morceaux) }))
    })
    r.on('timeout', () => r.destroy(new Error('le serveur ne répond pas')))
    r.on('error', rejeter)
    if (corps) r.write(corps)
    r.end()
  })
}

const base = (hote, port) => `http://${hote}:${Number(port) + 1}`

async function infoDistante(hote, port) {
  const r = await requete(`${base(hote, port)}/monde/info`)
  if (r.code !== 200) throw new Error(`le serveur répond ${r.code}`)
  return JSON.parse(r.corps.toString('utf8'))
}

// ── Publier ─────────────────────────────────────────────────────────────────

function dossierTravail() {
  const d = path.join(os.tmpdir(), 'voyage-lanceur', 'monde')
  fs.mkdirSync(d, { recursive: true })
  return d
}

async function publier({ hote, port, motDePasseMonde, nom, etiquette, note, par, dossier }) {
  const source = dossierSauvegardes(dossier)
  if (!source) throw new Error('dossier de sauvegardes introuvable')

  const fichiers = lister(source)
  if (fichiers.length === 0) throw new Error('aucune sauvegarde à publier')

  const archive = await compresser(source, path.join(dossierTravail(), 'a-publier.zip'))
  const octets = fs.readFileSync(archive)

  const parametres = new URLSearchParams({
    nom: nom || 'Monde',
    etiquette: etiquette || '',
    note: note || '',
    par: par || 'hôte',
    fichiers: String(fichiers.length),
  })

  const r = await requete(
    `${base(hote, port)}/monde/publier?${parametres}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': octets.length,
        'x-monde-motdepasse': motDePasseMonde ?? '',
      },
    },
    octets,
  )

  fs.rmSync(archive, { force: true })
  if (r.code !== 200) {
    let raison = `le serveur répond ${r.code}`
    try {
      raison = JSON.parse(r.corps.toString('utf8')).erreur ?? raison
    } catch {
      /* la reponse n'est pas du JSON */
    }
    throw new Error(raison)
  }
  return JSON.parse(r.corps.toString('utf8'))
}

// ── Apercu et installation ──────────────────────────────────────────────────

async function telechargerMonde({ hote, port, motDePasse }) {
  const q = motDePasse ? `?motdepasse=${encodeURIComponent(motDePasse)}` : ''
  const r = await requete(`${base(hote, port)}/monde/bundle${q}`)
  if (r.code === 404) throw new Error('aucun monde publié sur ce serveur')
  if (r.code === 401) throw new Error('mot de passe du serveur requis')
  if (r.code !== 200) throw new Error(`le serveur répond ${r.code}`)

  const archive = path.join(dossierTravail(), 'recu.zip')
  fs.writeFileSync(archive, r.corps)
  return { archive, empreinte: crypto.createHash('sha256').update(r.corps).digest('hex') }
}

/**
 * Ce que l'installation changerait, AVANT de rien toucher.
 *
 * ⚠️ LE JOUEUR DOIT VOIR CE QU'IL PERD AVANT DE CLIQUER. « remplace » et
 *    « chez toi seulement » sont les deux lignes qui comptent : ce sont ses
 *    heures de jeu.
 */
async function apercu({ hote, port, motDePasse, dossier }) {
  const distant = await infoDistante(hote, port)
  if (!distant.present) throw new Error('aucun monde publié sur ce serveur')

  const { archive, empreinte } = await telechargerMonde({ hote, port, motDePasse })
  if (distant.empreinte && empreinte !== distant.empreinte) {
    fs.rmSync(archive, { force: true })
    throw new Error('l’archive reçue ne correspond pas à son empreinte : téléchargement abandonné')
  }

  const entrees = await contenu(archive)
  const refusees = entrees.filter((e) => !nomAcceptable(e.nom)).map((e) => e.nom)
  const retenues = entrees.filter((e) => nomAcceptable(e.nom))

  const local = new Map(lister(dossierSauvegardes(dossier)).map((f) => [f.nom.toLowerCase(), f]))
  const ajoutes = []
  const remplaces = []
  for (const e of retenues) {
    const nom = path.basename(e.nom)
    if (local.has(nom.toLowerCase())) remplaces.push(nom)
    else ajoutes.push(nom)
  }
  const chezToiSeulement = [...local.values()]
    .filter((f) => !retenues.some((e) => path.basename(e.nom).toLowerCase() === f.nom.toLowerCase()))
    .map((f) => f.nom)

  return {
    distant,
    empreinte,
    archive,
    ajoutes,
    remplaces,
    chezToiSeulement,
    refusees,
    dossier: dossierSauvegardes(dossier),
  }
}

function dossierCoffre() {
  const d = path.join(os.homedir(), 'Voyage-Sauvegardes-Symbiose')
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** Met la partie actuelle de cote. Rend le chemin de la copie. */
async function mettreDeCote(dossier) {
  const source = dossierSauvegardes(dossier)
  if (!source || lister(source).length === 0) return null
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const cible = path.join(dossierCoffre(), `avant-${horodatage}.zip`)
  await compresser(source, cible)
  return cible
}

/**
 * Installe le monde du serveur.
 *
 * ⚠️ ON COPIE, ON NE VIDE PAS. Supprimer ce qui est « chez toi seulement »
 *    detruirait des parties que l'hote n'a simplement jamais eues. On ajoute
 *    et on remplace ; le reste est laisse tranquille, et l'apercu l'a dit.
 */
async function installer({ hote, port, motDePasse, dossier }) {
  const vue = await apercu({ hote, port, motDePasse, dossier })
  const cible = vue.dossier || dossierSauvegardes(dossier)
  if (!cible) throw new Error('dossier de sauvegardes introuvable')

  /*
    ⚠️ ON REGARDE DANS L'ARCHIVE AVANT DE L'OUVRIR. `contenu()` lit la table
       sans rien extraire ; `decompresser()` ecrit sur le disque. L'ordre
       inverse laissait `Expand-Archive` poser les fichiers d'abord et on ne
       triait qu'ensuite -- la copie vers le dossier du jeu etait bien gardee,
       mais ce qui avait deja ete ecrit ailleurs l'etait deja.

    ⚠️ ET ON REFUSE L'ARCHIVE ENTIERE, PAS SEULEMENT L'ENTREE FAUTIVE. Une
       archive qui contient un chemin pareil n'est pas une sauvegarde avec un
       defaut : c'est quelque chose d'autre. L'ouvrir a moitie serait pire que
       de la refuser.
  */
  const entrees = await contenu(vue.archive)
  const douteuses = entrees.filter((e) => !nomAcceptable(e.nom))
  if (douteuses.length) {
    throw Object.assign(
      new Error(`archive refusée : ${douteuses.length} entrée(s) illégitime(s)`),
      { cle: 'err.archiveDouteuse', valeurs: { nom: douteuses[0].nom.slice(0, 60) } },
    )
  }

  const copie = await mettreDeCote(dossier)

  const ouvert = await decompresser(vue.archive, path.join(dossierTravail(), 'ouvert'))

  let poses = 0
  for (const entree of entrees) {
    const nom = path.basename(entree.nom)
    const source = path.join(ouvert, entree.nom.replace(/\//g, path.sep))

    /*
      ⚠️ DERNIERE VERIFICATION APRES EXTRACTION. Le nom controle plus haut et
         le fichier reellement extrait peuvent differer ; on confirme que la
         source est bien sous le dossier temporaire avant de la copier.
    */
    const reel = fs.existsSync(source) ? fs.realpathSync(source) : null
    if (!reel || !reel.startsWith(fs.realpathSync(ouvert))) continue

    fs.copyFileSync(reel, path.join(cible, nom))
    poses++
  }

  fs.rmSync(ouvert, { recursive: true, force: true })
  fs.rmSync(vue.archive, { force: true })

  return {
    poses,
    copie,
    etiquette: vue.distant.etiquette,
    nom: vue.distant.nom,
    refusees: vue.refusees,
    chezToiSeulement: vue.chezToiSeulement,
  }
}

// ── Revenir en arriere ──────────────────────────────────────────────────────

function copiesLocales() {
  const d = dossierCoffre()
  if (!fs.existsSync(d)) return []
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(d, f))
      return { nom: f, chemin: path.join(d, f), taille: stat.size, date: stat.mtime.toISOString() }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
}

async function restaurer(chemin, dossier) {
  const copies = copiesLocales()
  /*
    ⚠️ ON NE RESTAURE QUE CE QU'ON A SOI-MEME MIS DE COTE. Accepter un chemin
       arbitraire venu de l'interface reviendrait a laisser n'importe quelle
       archive s'extraire dans le dossier du jeu.
  */
  if (!copies.some((c) => c.chemin === chemin)) throw new Error('copie inconnue')

  const cible = dossierSauvegardes(dossier)
  if (!cible) throw new Error('dossier de sauvegardes introuvable')

  // On met de cote l'etat actuel avant de le remplacer, lui aussi.
  const avant = await mettreDeCote(dossier)

  /*
    ⚠️ MEME ORDRE ICI : on regarde, puis on ouvre. C'est une copie qu'on a faite
       nous-memes, donc le risque est faible -- mais « faible » n'est pas une
       raison d'ecrire le controle a l'envers dans un endroit et pas l'autre.
  */
  const dedans = await contenu(chemin)
  const sales = dedans.filter((e) => !nomAcceptable(e.nom))
  if (sales.length) {
    throw Object.assign(new Error('archive refusée'), {
      cle: 'err.archiveDouteuse',
      valeurs: { nom: sales[0].nom.slice(0, 60) },
    })
  }

  const ouvert = await decompresser(chemin, path.join(dossierTravail(), 'restauration'))
  let poses = 0
  for (const e of fs.readdirSync(ouvert, { withFileTypes: true })) {
    if (!e.isFile() || !nomAcceptable(e.name)) continue
    fs.copyFileSync(path.join(ouvert, e.name), path.join(cible, e.name))
    poses++
  }
  fs.rmSync(ouvert, { recursive: true, force: true })
  return { poses, avant }
}

module.exports = {
  dossierSauvegardes,
  dossierCoffre,
  lister,
  infoDistante,
  publier,
  apercu,
  installer,
  copiesLocales,
  restaurer,
  mettreDeCote,
  nomAcceptable,
  contenu,
  compresser,
  decompresser,
}
