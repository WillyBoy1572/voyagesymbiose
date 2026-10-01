'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LISTE DE SERVEURS
 * ═══════════════════════════════════════════════════════════════════════════
 *  Chaque serveur Voyage expose `GET /info` sur son port TCP. Le lanceur
 *  interroge ceux que le joueur a enregistres, et lit l'annuaire public pour
 *  proposer ceux qui ont choisi de s'y faire connaitre.
 *
 *  ⚠️ UN SERVEUR DE L'ANNUAIRE N'EST PAS UN SIGNET. Il apparait dans la liste,
 *     marque `public`, mais il n'est pas ecrit dans le fichier du joueur : le
 *     lendemain il peut avoir disparu, et une liste de signets qui se remplit
 *     toute seule de serveurs morts est pire qu'une liste vide.
 *
 *  ⚠️ CE QUE L'ANNUAIRE DIT EST VERIFIE PAR LE LANCEUR LUI-MEME. On interroge
 *     chaque serveur avant de l'afficher comme en ligne : l'annuaire a pu etre
 *     interroge il y a trois minutes, le serveur a pu tomber depuis.
 *
 *  ⚠️ UN SERVEUR QUI NE REPOND PAS RESTE AFFICHE, EN GRIS. Le faire
 *     disparaitre ferait croire au joueur qu'il a perdu son signet.
 *
 *  ⚠️ CHAQUE INTERROGATION A UN DELAI COURT. Sans lui, un seul serveur
 *     injoignable fige toute la liste pendant trente secondes.
 */

const FICHIER = path.join(os.homedir(), '.symbiose-voyage', 'serveurs.json')

function lire() {
  try {
    const brut = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
    return Array.isArray(brut) ? brut : []
  } catch {
    return []
  }
}

function ecrire(liste) {
  fs.mkdirSync(path.dirname(FICHIER), { recursive: true })
  fs.writeFileSync(FICHIER, JSON.stringify(liste, null, 1), 'utf8')
}

/** Decoupe « hote:port » proprement, sans faire confiance a la saisie. */
function analyser(adresse) {
  const texte = String(adresse || '').trim().replace(/^\w+:\/\//, '')
  const m = texte.match(/^([A-Za-z0-9._-]{1,253})(?::(\d{1,5}))?$/)
  if (!m) return null
  const port = m[2] ? Number.parseInt(m[2], 10) : 7777
  if (port < 1 || port > 65535) return null
  return { hote: m[1], port }
}

function ajouter(adresse) {
  const a = analyser(adresse)
  if (!a) return { ok: false, erreur: 'Adresse invalide. Exemple : 192.168.0.50:30150' }
  const liste = lire()
  if (liste.some((s) => s.hote === a.hote && s.port === a.port)) {
    return { ok: false, erreur: 'Ce serveur est déjà dans ta liste.' }
  }
  liste.push(a)
  ecrire(liste)
  return { ok: true, liste }
}

function retirer(hote, port) {
  const liste = lire().filter((s) => !(s.hote === hote && s.port === port))
  ecrire(liste)
  return liste
}

/**
 * Interroge un serveur.
 *
 * ⚠️ LE PORT DU JEU EST EN UDP, CELUI DES INFOS EN TCP, ET C'EST LE SECOND + 1
 *    PAR DEFAUT. On interroge donc `port + 1` sauf si le joueur a donne le
 *    port TCP directement.
 */
async function interroger(serveur) {
  // Les champs venus de l'annuaire (public, pays, monde) sont conserves tels quels.
  const base = { ...serveur, enLigne: false }
  for (const portInfo of [serveur.port + 1, serveur.port]) {
    try {
      const r = await fetch(`http://${serveur.hote}:${portInfo}/info`, {
      // Un serveur listé ne redirige pas : s'il le fait, ce n'en est pas un.
      redirect: 'error',
        signal: AbortSignal.timeout(2500),
      })
      if (!r.ok) continue
      const info = await r.json()
      if (!info || typeof info.nom !== 'string') continue
      return {
        ...base,
        enLigne: true,
        portInfo,
        nom: info.nom,
        joueurs: info.joueurs ?? 0,
        maxJoueurs: info.maxJoueurs ?? 0,
        motDePasse: Boolean(info.motDePasse),
        version: info.version ?? '?',
      }
    } catch {
      /* on essaie le port suivant */
    }
  }
  return base
}

/** L'adresse de l'annuaire public. Un seul endroit a changer. */
const ANNUAIRE = 'https://caretakermp.symbioseheritage.ca/api/annuaire'

/**
 * Les serveurs qui se sont annonces publiquement.
 *
 * ⚠️ UN ANNUAIRE INJOIGNABLE N'EST PAS UNE PANNE DU LANCEUR. On rend une liste
 *    vide et les signets du joueur s'affichent comme avant.
 */
async function annuaire() {
  try {
    const r = await fetch(ANNUAIRE, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return []
    const d = await r.json()
    if (!d || !Array.isArray(d.serveurs)) return []

    const sortie = []
    for (const brut of d.serveurs.slice(0, 100)) {
      const a = analyser(brut && brut.adresse)
      if (!a) continue
      sortie.push({
        ...a,
        public: true,
        /*
          ⚠️ ON GARDE CE QUE L'ANNUAIRE DIT, MAIS ON NE S'EN SERT PAS POUR
             AFFICHER « EN LIGNE ». C'est `interroger` qui tranche, juste apres.
        */
        nomAnnonce: typeof brut.nom === 'string' ? brut.nom.slice(0, 60) : null,
        pays: typeof brut.pays === 'string' ? brut.pays.slice(0, 8) : null,
        monde: typeof brut.monde === 'string' ? brut.monde.slice(0, 60) : null,
      })
    }
    return sortie
  } catch {
    return []
  }
}

async function rafraichir() {
  const signets = lire()
  const publics = await annuaire()

  /*
    ⚠️ UN SERVEUR DEJA EN SIGNET N'APPARAIT PAS DEUX FOIS. Le joueur a pu
       ajouter a la main un serveur qui s'annonce aussi : la meme carte deux
       fois de suite le ferait douter de ce qu'il lit.
  */
  const deja = new Set(signets.map((s) => `${s.hote}:${s.port}`))
  const aInterroger = [...signets, ...publics.filter((p) => !deja.has(`${p.hote}:${p.port}`))]

  return Promise.all(aInterroger.map(interroger))
}

module.exports = { lire, ajouter, retirer, rafraichir, interroger, analyser, annuaire, FICHIER, ANNUAIRE }
