'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LISTE DE SERVEURS
 * ═══════════════════════════════════════════════════════════════════════════
 *  Chaque serveur Voyage expose `GET /info` sur son port TCP. Le lanceur
 *  interroge ceux que le joueur a enregistres, plus ceux de la liste publique
 *  quand elle existera.
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
  const base = { ...serveur, enLigne: false }
  for (const portInfo of [serveur.port + 1, serveur.port]) {
    try {
      const r = await fetch(`http://${serveur.hote}:${portInfo}/info`, {
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

async function rafraichir() {
  const liste = lire()
  return Promise.all(liste.map(interroger))
}

module.exports = { lire, ajouter, retirer, rafraichir, interroger, analyser, FICHIER }
