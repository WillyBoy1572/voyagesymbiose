'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HÉBERGER DEPUIS LE LANCEUR — est-ce que ça marche vraiment ?
 * ═══════════════════════════════════════════════════════════════════════════
 *      node essais/heberger.js
 *
 *  On démarre le VRAI serveur embarqué, avec une VRAIE sauvegarde, et on lui
 *  parle par le réseau. Pas de simulacre : si ce fichier passe, un joueur peut
 *  héberger sa partie d'un clic.
 *
 *  ⚠️ ON VÉRIFIE L'ARRÊT PROPRE, PAS SEULEMENT LE DÉMARRAGE. Sous Windows,
 *     `kill` termine le processus d'autorité : les positions, les identités et
 *     le coffre perdent leur dernière minute. Le code de sortie 0 est la preuve
 *     que le serveur s'est arrêté de lui-même, par `stop`.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const heberger = require('../src/heberger')

/** Un port à nous, loin des ports par défaut. */
const PORT = 29177

let echecs = 0
let essais = 0

function ok(condition, libelle, detail = '') {
  essais++
  if (condition) {
    console.log(`  ✔ ${libelle}`)
  } else {
    echecs++
    console.log(`  ✘ ${libelle}${detail ? ` — ${detail}` : ''}`)
  }
}

function titre(texte) {
  console.log('\n── ' + texte + ' ' + '─'.repeat(Math.max(2, 52 - texte.length)))
}

const dodo = (ms) => new Promise((r) => setTimeout(r, ms))

async function http(chemin, entetes = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT + 1}${chemin}`, {
      headers: entetes,
      signal: AbortSignal.timeout(3000),
    })
    return { code: r.status, corps: await r.json().catch(() => null) }
  } catch (e) {
    return { code: 0, corps: null, erreur: e.message }
  }
}

async function principal() {
  const racine = path.join(os.tmpdir(), 'voyage-essai-heberger-' + process.pid)
  const saves = path.join(racine, 'sauvegardes')
  fs.rmSync(racine, { recursive: true, force: true })
  fs.mkdirSync(saves, { recursive: true })

  /*
    ⚠️ UNE VRAIE SAUVEGARDE, PAS UN FICHIER VIDE. C'est elle qui sera compressée
       et posée dans le serveur : un dossier vide ferait passer l'essai en
       sautant exactement ce qu'on veut vérifier.
  */
  fs.writeFileSync(path.join(saves, 'Monde_0.sav'), Buffer.alloc(4096, 7))
  fs.writeFileSync(path.join(saves, 'Progress.sav'), Buffer.alloc(1024, 3))

  heberger.poserContexte({ dossier: racine })

  const journal = []
  heberger.surLigne((l) => journal.push(typeof l === 'string' ? l : l.cle))

  titre('Démarrage')

  let etat
  try {
    etat = await heberger.demarrer({
      nom: 'Partie d’essai',
      motDePasse: 'secret-essai',
      maxJoueurs: 16,
      port: PORT,
      partagerLaPartie: true,
      public: false,
      pseudo: 'Emeric',
      dossierSauvegardes: saves,
      empreinte: 'abcdef0123456789',
    })
    ok(etat.actif && etat.pret, 'le serveur embarqué démarre')
  } catch (e) {
    ok(false, 'le serveur embarqué démarre', e.message)
    console.log('\n── journal ──\n' + journal.join('\n'))
    process.exit(1)
  }

  ok(etat.reglages.maxJoueurs === 16, 'il accepte 16 places', String(etat.reglages.maxJoueurs))
  ok(etat.reglages.protege === true, 'il est protégé par un mot de passe')

  titre('Ce qu’il annonce')

  const info = await http('/info')
  ok(info.code === 200, '/info répond', info.erreur ?? String(info.code))
  ok(info.corps?.nom === 'Partie d’essai', 'avec le nom choisi', info.corps?.nom)
  ok(info.corps?.maxJoueurs === 16, 'et 16 places', String(info.corps?.maxJoueurs))
  ok(info.corps?.motDePasse === true, 'et le mot de passe signalé')

  titre('La partie de l’hôte')

  /*
    ⚠️ C'EST LE CŒUR DE LA FONCTIONNALITÉ. Sur un serveur loué, publier un monde
       demande le mot de passe de publication — que seul l'hébergeur possède.
       Ici l'archive est écrite directement dans le dossier du serveur, avant
       qu'il démarre.
  */
  const monde = await http('/monde/info')
  ok(monde.corps?.present === true, 'la sauvegarde de l’hôte est dans le serveur', JSON.stringify(monde.corps))
  ok(monde.corps?.fichiers === 2, 'avec ses deux fichiers', String(monde.corps?.fichiers))
  ok(
    typeof monde.corps?.empreinte === 'string' && monde.corps.empreinte.length === 64,
    'et une empreinte calculée sur l’archive',
  )
  ok(monde.corps?.publiePar === 'Emeric', 'publiée au nom de l’hôte', monde.corps?.publiePar)

  const dossier = heberger.dossierServeur()
  ok(fs.existsSync(path.join(dossier, 'donnees', 'monde.zip')), 'l’archive est bien sur le disque')
  ok(!fs.existsSync(path.join(dossier, 'donnees', 'monde-en-cours.zip')), 'et aucun fichier temporaire ne traîne')

  titre('L’hôte commande son serveur')

  const admin = heberger.adresseAdmin()
  ok(Boolean(admin?.cle), 'une clé d’administration a été fabriquée')

  const sansCle = await http('/admin/etat')
  ok(sansCle.code === 404, 'sans la clé, /admin/etat répond 404', String(sansCle.code))

  const avecCle = await http('/admin/etat', { 'X-Admin-Cle': admin.cle })
  ok(avecCle.code === 200, 'avec la clé, il répond')
  ok(avecCle.corps?.annuaire?.actif === false, 'l’annuaire est éteint par défaut', JSON.stringify(avecCle.corps?.annuaire))

  /*
    ⚠️ L'HÔTE EST PROPRIÉTAIRE DE SON PROPRE SERVEUR. Sans ça il pourrait
       expulser, mais ni bannir ni donner un rôle sur une machine qui est la
       sienne.
  */
  const sanctions = await http('/admin/sanctions', { 'X-Admin-Cle': admin.cle })
  ok(sanctions.code === 200, '/admin/sanctions répond')

  journal.length = 0
  ok(heberger.commande('/joueurs') === true, 'une commande part par la console')
  await dodo(600)
  ok(
    journal.some((l) => String(l).includes('0/16')),
    'et le serveur y répond dans le journal',
    journal.slice(-3).join(' | '),
  )

  // ⚠️ `stop` ne doit PAS pouvoir passer par là : c'est l'arrêt, pas une commande.
  ok(heberger.commande('stop') === false, '« stop » n’est pas accepté comme commande')

  titre('Arrêt propre')

  const avantArret = Date.now()
  await heberger.arreter()
  const duree = Date.now() - avantArret

  ok(!heberger.actif(), 'le serveur est arrêté')
  ok(duree < 3500, 'il s’est arrêté de lui-même, sans qu’on le force', `${duree} ms`)
  ok(
    !journal.includes('heb.force'),
    'et il n’a pas fallu le tuer',
    journal.filter((l) => String(l).includes('force')).join(' | '),
  )

  await dodo(300)
  const apres = await http('/info')
  ok(apres.code === 0, 'il ne répond plus', String(apres.code))

  titre('Sans sauvegarde')

  /*
    ⚠️ UN DOSSIER VIDE DOIT ÊTRE REFUSÉ AVEC UNE PHRASE, pas démarrer un serveur
       qui promet un monde absent.
  */
  const vide = path.join(racine, 'vide')
  fs.mkdirSync(vide, { recursive: true })
  let refus = null
  try {
    await heberger.demarrer({
      nom: 'Sans partie',
      port: PORT + 10,
      partagerLaPartie: true,
      dossierSauvegardes: vide,
    })
  } catch (e) {
    refus = e
  }
  ok(Boolean(refus), 'démarrer sans aucune sauvegarde est refusé')
  ok(refus?.cle === 'err.aucuneSauvegarde', 'avec une clé que l’interface sait traduire', refus?.cle)
  ok(!heberger.actif(), 'et aucun serveur ne traîne derrière')

  heberger.nettoyer()
  await dodo(300)
  fs.rmSync(racine, { recursive: true, force: true })

  console.log('\n' + '─'.repeat(58))
  console.log(echecs === 0 ? `TOUT PASSE — ${essais} vérifications` : `${echecs} ÉCHEC(S) sur ${essais}`)
  if (echecs) console.log('\n── journal du serveur ──\n' + journal.slice(-25).join('\n'))
  process.exit(echecs ? 1 : 0)
}

principal().catch((e) => {
  console.error('le banc d’essai a planté :', e)
  heberger.nettoyer()
  process.exit(1)
})
