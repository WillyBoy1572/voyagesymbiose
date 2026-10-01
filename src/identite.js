'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  IDENTITE — une clé, pas un mot de passe
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le lanceur fabrique une paire ed25519 au premier démarrage. La partie
 *  publique voyage vers les serveurs ; la privée ne quitte jamais cette
 *  machine. L'empreinte de la publique EST l'identité du joueur : c'est elle
 *  qui porte son rôle, son profil et ses éventuelles sanctions.
 *
 *  ⚠️ PAS DE STEAM, ET CE N'EST PAS UN CHOIX. Toute identité Steam passe par le
 *     Steamworks SDK, qui exige un App ID attribué à une application. Le mod
 *     n'en a pas, et emprunter celui de l'éditeur du jeu serait utiliser son
 *     identité sans accord.
 *
 *  ⚠️ LA CLÉ PRIVÉE N'EST JAMAIS AFFICHÉE, JAMAIS JOURNALISÉE, JAMAIS PASSÉE
 *     EN ARGUMENT. Le lanceur signe lui-même et ne transmet au pont que la
 *     signature — une ligne de commande se lit dans le gestionnaire des tâches
 *     de n'importe quel autre programme.
 *
 *  ⚠️ SIGNER N'EST PAS S'AUTHENTIFIER AUPRÈS D'UN TIERS. On ne crée aucun
 *     compte, on ne contacte aucun service : la paire est locale, et un serveur
 *     qui ne la connaît pas voit simplement un joueur qu'il n'a jamais vu.
 *
 *  ⚠️ PERDRE LE FICHIER, C'EST PERDRE L'IDENTITÉ. Pas de récupération possible,
 *     et c'est le prix de ne dépendre de personne. Le lanceur propose donc de
 *     l'exporter, et prévient avant d'en générer une nouvelle.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Le préfixe empêche qu'une signature faite ailleurs serve ici. */
const DOMAINE = 'voyage-identite-v1'

/** Longueur de l'empreinte affichée. 16 caractères hexa = 64 bits. */
const LONGUEUR_EMPREINTE = 16

let cache = null

function cheminFichier(dossierDonnees) {
  return path.join(dossierDonnees, 'identite.json')
}

/** Empreinte courte et stable d'une clé publique. */
function empreinteDe(clePubliqueBase64) {
  return crypto
    .createHash('sha256')
    .update(String(clePubliqueBase64), 'utf8')
    .digest('hex')
    .slice(0, LONGUEUR_EMPREINTE)
}

/**
 * Charge l'identité, ou la crée au premier démarrage.
 *
 * ⚠️ LE FICHIER EST ÉCRIT EN MODE 0600 QUAND LE SYSTÈME LE PERMET. Sous Windows
 *    les permissions POSIX sont ignorées, mais le dossier de données de
 *    l'application est déjà propre à l'utilisateur : on ne prétend pas faire
 *    mieux que ça.
 */
function charger(dossierDonnees) {
  if (cache) return cache
  const fichier = cheminFichier(dossierDonnees)

  try {
    const brut = JSON.parse(fs.readFileSync(fichier, 'utf8'))
    if (typeof brut.privee === 'string' && typeof brut.publique === 'string') {
      cache = {
        publique: brut.publique,
        privee: brut.privee,
        empreinte: empreinteDe(brut.publique),
        creeLe: Number(brut.creeLe) || Date.now(),
        nouvelle: false,
      }
      return cache
    }
  } catch {
    /* premier démarrage, ou fichier abîmé : on en refait une */
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publique = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const privee = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')

  cache = {
    publique,
    privee,
    empreinte: empreinteDe(publique),
    creeLe: Date.now(),
    nouvelle: true,
  }

  try {
    fs.mkdirSync(path.dirname(fichier), { recursive: true })
    const abri = `${fichier}.tmp`
    fs.writeFileSync(
      abri,
      JSON.stringify({ publique, privee, creeLe: cache.creeLe }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    )
    fs.renameSync(abri, fichier)
  } catch {
    /*
      ⚠️ UNE IDENTITÉ NON ENREGISTRÉE RESTE UTILISABLE POUR CETTE SESSION. On ne
         refuse pas de jouer parce que le disque est en lecture seule : le joueur
         sera simplement vu comme quelqu'un de nouveau au prochain démarrage.
    */
  }

  return cache
}

/**
 * Signe une connexion. Rend `{cle, ts, sig, empreinte}`, ou `null`.
 *
 * ⚠️ LE TEXTE SIGNÉ CONTIENT LE PSEUDO ET L'HEURE. Le pseudo, pour qu'une
 *    signature volée ne serve pas à entrer sous un autre nom ; l'heure, pour
 *    que le serveur puisse refuser une signature trop vieille. Le serveur
 *    reconstruit la même chaîne au caractère près.
 */
function signer(dossierDonnees, nom) {
  const identite = charger(dossierDonnees)
  if (!identite) return null

  const ts = Date.now()
  const message = `${DOMAINE}|${identite.publique}|${nom}|${ts}`

  try {
    const cle = crypto.createPrivateKey({
      key: Buffer.from(identite.privee, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    const sig = crypto.sign(null, Buffer.from(message, 'utf8'), cle).toString('base64')
    return { cle: identite.publique, ts, sig, empreinte: identite.empreinte }
  } catch {
    // Sans signature, le joueur entre en anonyme : il joue, sans rôle durable.
    return null
  }
}

/** Ce que l'interface peut montrer. La clé privée n'en fait pas partie. */
function publique(dossierDonnees) {
  const i = charger(dossierDonnees)
  return { empreinte: i.empreinte, creeLe: i.creeLe, nouvelle: i.nouvelle }
}

/**
 * Remplace l'identité par une neuve.
 *
 * ⚠️ C'EST IRRÉVERSIBLE, ET ÇA PERD TOUT. Rôles, profil, heures de jeu : tout
 *    est attaché à l'ancienne empreinte. L'interface doit demander confirmation
 *    avant d'appeler ça — ce module ne le fait pas à sa place.
 */
function regenerer(dossierDonnees) {
  const fichier = cheminFichier(dossierDonnees)
  try {
    // On met de côté plutôt que d'effacer : une identité perdue ne se retrouve pas.
    if (fs.existsSync(fichier)) {
      fs.renameSync(fichier, `${fichier}.${Date.now()}.ancienne`)
    }
  } catch {
    /* on continue : la nouvelle écrasera */
  }
  cache = null
  return publique(dossierDonnees)
}

module.exports = { charger, signer, publique, regenerer, empreinteDe, DOMAINE }
