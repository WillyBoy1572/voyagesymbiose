'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LE LIEN — le lanceur tient le pont entre le jeu et le serveur
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ ON NE DEMANDE PAS D'INSTALLER NODE. Electron EST Node : lance avec
 *     `ELECTRON_RUN_AS_NODE=1`, son propre executable execute `pont.js`
 *     comme le ferait `node`. Le joueur n'installe rien d'autre.
 *
 *  ⚠️ `pont.js` DOIT SORTIR DE L'ARCHIVE asar. Un fichier reste dans l'asar
 *     ne peut pas etre lance comme programme : on empaquette donc `pont/`
 *     en `unpacked`, et on corrige le chemin ici.
 *
 *  ⚠️ UN SEUL PONT A LA FOIS. Deux ponts se disputeraient le meme tube
 *     nomme : le second echouerait, et le joueur verrait « connecte » sans
 *     que rien ne passe.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** On garde de quoi comprendre, pas tout l'historique. */
const LIGNES_GARDEES = 400

let processus = null
let cible = null
let lignes = []
let ecouteur = null
let ecouteurCommande = null

/** Appelee a chaque nouvelle ligne, pour que l'interface suive en direct. */
function surLigne(f) {
  ecouteur = f
}

/** Appelee quand le JEU demande quelque chose (touche F7, F9…). */
function surCommande(f) {
  ecouteurCommande = f
}

/*
  ⚠️ DEUX SORTES DE LIGNES. Celles du pont arrivent deja ecrites dans la
     bonne langue (il recoit `--langue`) ; les notres partent en CLE et la
     page les traduit. On garde donc les deux formes plutot que de figer du
     francais ici.
*/
function noter(texte) {
  const heure = new Date().toTimeString().slice(0, 8)
  const ligne = typeof texte === 'string' ? `${heure} ${texte}` : { heure, ...texte }
  lignes.push(ligne)
  if (lignes.length > LIGNES_GARDEES) lignes = lignes.slice(-LIGNES_GARDEES)
  if (ecouteur) ecouteur(ligne)
}

/**
 * Le chemin de `pont.js`, dans l'application installee comme en developpement.
 */
function cheminPont() {
  const dansAsar = path.join(__dirname, '..', 'pont', 'pont.js')
  // Hors developpement, le fichier vit dans `app.asar.unpacked`.
  const dehors = dansAsar.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  if (fs.existsSync(dehors)) return dehors
  if (fs.existsSync(dansAsar)) return dansAsar
  throw Object.assign(new Error('pont.js est introuvable dans le lanceur.'), { cle: 'err.pontIntrouvable' })
}

function actif() {
  return Boolean(processus) && processus.exitCode === null
}

function etat() {
  // Le mot de passe ne sort pas d'ici : l'interface n'en a pas besoin.
  const sansSecret = cible ? { hote: cible.hote, port: cible.port, nom: cible.nom } : null
  return { actif: actif(), cible: sansSecret, lignes }
}

/** Ce que le processus principal peut utiliser pour agir a la place du jeu. */
function cibleComplete() {
  return cible
}

/*
  ⚠️ LE MOT DE PASSE DU SERVEUR RESTE EN MEMOIRE, JAMAIS SUR DISQUE. Le joueur
     vient de le taper pour se connecter ; le redemander a chaque action
     lancee depuis le jeu serait absurde. Il part avec le processus.
*/
function demarrer({ hote, port, nom, motDePasse = '', langue = 'fr' }) {
  if (actif()) arreter()

  const adresse = `${hote}:${port}`
  const arguments_ = [cheminPont(), '--serveur', adresse, '--nom', nom || 'Joueur', '--langue', langue]
  if (motDePasse) arguments_.push('--motdepasse', motDePasse)

  lignes = []
  cible = { hote, port, nom, motDePasse }
  noter({ cle: 'lien.demarrage', valeurs: { adresse } })

  processus = spawn(process.execPath, arguments_, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  /*
    ⚠️ ON LIT LES DEUX SORTIES. Un pont qui meurt en ecrivant sur stderr
       laisserait sinon le joueur devant une fenetre muette.
  */
  let reste = ''
  const avaler = (bout) => {
    reste += bout
    const morceaux = reste.split(/\r?\n/)
    reste = morceaux.pop() ?? ''
    for (const m of morceaux) {
      if (!m.trim()) continue
      const commande = m.match(/^##voyage-cmd\s+(\S+)/)
      if (commande) {
        if (ecouteurCommande) ecouteurCommande(commande[1])
        continue
      }
      noter(m.replace(/^\d{2}:\d{2}:\d{2}\s*/, ''))
    }
  }
  processus.stdout.setEncoding('utf8')
  processus.stderr.setEncoding('utf8')
  processus.stdout.on('data', avaler)
  processus.stderr.on('data', avaler)

  processus.on('error', (e) => noter({ cle: 'lien.pasDemarre', valeurs: { raison: e.message } }))
  processus.on('exit', (code) => {
    noter(code === 0 || code === null ? { cle: 'lien.fini' } : { cle: 'lien.finiCode', valeurs: { code } })
    processus = null
  })

  return etat()
}

function arreter() {
  if (processus) {
    /*
      ⚠️ ON REFERME SON ENTREE, ON NE LE TUE PAS. Sous Windows, `kill` met fin
         au processus d'autorite : le pont n'a pas le temps d'envoyer son
         `adieu` et le joueur reste affiche sur le serveur jusqu'a expiration
         du delai d'inactivite. Fermer stdin, lui, marche partout. Le kill
         reste, mais en dernier recours.
    */
    const condamne = processus
    try {
      condamne.stdin.end()
    } catch {
      /* il est peut-etre deja mort */
    }
    setTimeout(() => {
      if (condamne.exitCode === null) condamne.kill()
    }, 2000)
    processus = null
  }
  cible = null
  return etat()
}

/** Au plus tard a la fermeture du lanceur, on ne laisse pas de pont derriere. */
function nettoyer() {
  if (processus) {
    try {
      processus.stdin.end()
    } catch {
      /* rien a faire */
    }
    processus.kill()
  }
  processus = null
}

module.exports = { demarrer, arreter, etat, actif, surLigne, surCommande, cibleComplete, nettoyer }
