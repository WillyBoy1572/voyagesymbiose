'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  IDENTITE — savoir que c'est bien la meme personne qui revient
 * ═══════════════════════════════════════════════════════════════════════════
 *  Un pseudo ne prouve rien : n'importe qui peut taper le tien. Pour qu'un
 *  role, un bannissement ou un profil tiennent, il faut quelque chose que
 *  seul le proprietaire possede.
 *
 *  ⚠️ PAS DE STEAM, ET CE N'EST PAS UN CHOIX. Toute identite Steam passe par
 *     le Steamworks SDK, qui exige un App ID. Le mod n'en a pas, et emprunter
 *     celui de l'editeur du jeu serait utiliser son identite sans accord. On
 *     fabrique donc la notre.
 *
 *  ⚠️ UNE CLE, PAS UN MOT DE PASSE. Le lanceur genere une paire ed25519 une
 *     fois pour toutes. La partie publique voyage, la privee ne quitte jamais
 *     la machine. L'empreinte de la publique EST l'identite.
 *
 *  ⚠️ UNE SIGNATURE QUI NE VIEILLIT PAS EST UNE SIGNATURE REJOUABLE. On exige
 *     un horodatage recent ET on retient les signatures deja vues : sans les
 *     deux, quiconque capture un paquet d'arrivee peut se presenter a la
 *     place de son auteur, pour toujours.
 *
 *  ⚠️ L'ANONYME RESTE ADMIS. Un joueur sans cle entre quand meme — il n'aura
 *     simplement ni role, ni profil durable. Refuser serait fermer la porte a
 *     quiconque n'a pas le lanceur.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Le prefixe empeche qu'une signature faite ailleurs serve ici. */
const DOMAINE = 'voyage-identite-v1'

/** Au-dela, l'horodatage est trop vieux ou vient du futur : on refuse. */
const FENETRE_MS = 120_000

/**
 * Au-dela de ce silence, un profil est oublie : il n'apprend plus rien sur
 * personne et il pese dans le fichier de tout le monde.
 *
 * ⚠️ ON NE JETTE PAS UN PROFIL QUI PORTE QUELQUE CHOSE. Un role donne, une
 *    note ecrite par l'hote : ce sont des decisions, pas des traces de
 *    passage. Les oublier rendrait son role a quelqu'un qui l'a perdu, ou
 *    effacerait la raison pour laquelle on le surveillait.
 */
const PROFIL_OUBLIE_APRES_MS = 365 * 24 * 60 * 60 * 1000

/** Combien de signatures on retient pour refuser un rejeu. */
const SIGNATURES_RETENUES = 4096

/** Longueur de l'empreinte affichee. 16 caracteres hexa = 64 bits. */
const LONGUEUR_EMPREINTE = 16

function maintenant() {
  return Date.now()
}

/**
 * Empreinte courte et stable d'une cle publique.
 *
 * ⚠️ ON HACHE, ON NE TRONQUE PAS LA CLE. Deux cles peuvent partager un debut ;
 *    deux empreintes SHA-256 non.
 */
function empreinteDe(clePubliqueBase64) {
  return crypto
    .createHash('sha256')
    .update(String(clePubliqueBase64), 'utf8')
    .digest('hex')
    .slice(0, LONGUEUR_EMPREINTE)
}

/**
 * Reconstruit une cle publique ed25519 depuis sa forme transportee (SPKI en
 * base64). Rend `null` si ce n'est pas une cle valide.
 *
 * ⚠️ ON NE FAIT CONFIANCE A RIEN DE CE QUI ARRIVE. `createPublicKey` leve sur
 *    une entree bidon, et une exception non rattrapee ici couperait l'arrivee
 *    de tous les joueurs.
 */
function lireCle(base64) {
  if (typeof base64 !== 'string' || base64.length < 32 || base64.length > 512) return null
  try {
    const cle = crypto.createPublicKey({
      key: Buffer.from(base64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    if (cle.asymmetricKeyType !== 'ed25519') return null
    return cle
  } catch {
    return null
  }
}

/** Le texte exact qui est signe. Le client doit produire le meme, au caractere. */
function messageASigner(clePublique, nom, ts) {
  return `${DOMAINE}|${clePublique}|${nom}|${ts}`
}

class Identites {
  /**
   * @param {object} config
   * @param {(texte: string) => void} [journal]
   */
  constructor(config, journal) {
    this.config = config
    this.journal = journal || (() => {})
    this.fichier = path.join(config.dossierDonnees, 'identites.json')
    /** @type {Map<string, object>} empreinte -> profil */
    this.profils = new Map()
    /** Signatures deja vues, pour refuser un rejeu. */
    this.signaturesVues = new Map()
    this.sale = false
    this.#charger()
  }

  // ── Disque ──────────────────────────────────────────────────────────────

  #charger() {
    try {
      const brut = JSON.parse(fs.readFileSync(this.fichier, 'utf8'))
      for (const p of brut.profils || []) {
        if (typeof p.empreinte !== 'string') continue
        this.profils.set(p.empreinte, {
          empreinte: p.empreinte,
          nom: typeof p.nom === 'string' ? p.nom : '?',
          noms: Array.isArray(p.noms) ? p.noms.slice(0, 8) : [],
          vuLaPremiereFois: Number(p.vuLaPremiereFois) || maintenant(),
          vuLaDerniereFois: Number(p.vuLaDerniereFois) || maintenant(),
          tempsDeJeuMs: Number(p.tempsDeJeuMs) || 0,
          sessions: Number(p.sessions) || 0,
          role: typeof p.role === 'string' ? p.role : null,
          notes: typeof p.notes === 'string' ? p.notes.slice(0, 240) : '',
        })
      }
      const oublies = this.#oublierLesAnciens()
      this.journal(
        `${this.profils.size} identité(s) connue(s)` +
          (oublies ? ` (${oublies} oubliée(s), plus vues depuis un an)` : '') +
          '.',
      )
    } catch {
      /* premier demarrage : rien a charger */
    }
  }

  enregistrerSiBesoin() {
    if (!this.sale) return false
    try {
      fs.mkdirSync(path.dirname(this.fichier), { recursive: true })
      const corps = JSON.stringify({ profils: [...this.profils.values()] }, null, 2)
      /*
        ⚠️ ON ECRIT A COTE PUIS ON RENOMME. Une coupure de courant au milieu
           d'une ecriture en place laisserait un fichier tronque — et au
           prochain demarrage, plus un seul role ni profil.
      */
      const abri = `${this.fichier}.tmp`
      fs.writeFileSync(abri, corps, 'utf8')
      fs.renameSync(abri, this.fichier)
      this.sale = false
      return true
    } catch (e) {
      this.journal(`identités non enregistrées : ${e.message}`)
      return false
    }
  }

  // ── Verification ────────────────────────────────────────────────────────

  /**
   * Verifie la preuve d'identite jointe a une arrivee.
   *
   * Rend `{ empreinte, nouvelle }` si la preuve tient, `{ refus }` sinon, et
   * `null` quand il n'y a simplement pas de preuve (joueur anonyme).
   */
  verifier({ cle, nom, ts, sig }) {
    if (!cle && !sig) return null // anonyme, et c'est permis

    const clePublique = lireCle(cle)
    if (!clePublique) return { refus: 'cle_invalide' }
    if (typeof sig !== 'string' || sig.length < 32 || sig.length > 256) {
      return { refus: 'signature_invalide' }
    }

    const ecart = Math.abs(maintenant() - Number(ts || 0))
    if (!Number.isFinite(ecart) || ecart > FENETRE_MS) return { refus: 'horodatage' }

    /*
      ⚠️ LE REJEU SE REFUSE AVANT LA VERIFICATION, PAS APRES. Verifier d'abord
         ferait travailler le processeur pour un paquet qu'on allait jeter — et
         c'est exactement ce qu'un attaquant repeterait.
    */
    const empreinteSig = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 32)
    if (this.signaturesVues.has(empreinteSig)) return { refus: 'rejeu' }

    let bonne = false
    try {
      bonne = crypto.verify(
        null,
        Buffer.from(messageASigner(cle, nom, ts), 'utf8'),
        clePublique,
        Buffer.from(sig, 'base64'),
      )
    } catch {
      return { refus: 'signature_invalide' }
    }
    if (!bonne) return { refus: 'signature_invalide' }

    this.#retenirSignature(empreinteSig)
    const empreinte = empreinteDe(cle)
    const nouvelle = !this.profils.has(empreinte)
    return { empreinte, nouvelle }
  }

  #retenirSignature(empreinte) {
    this.signaturesVues.set(empreinte, maintenant())
    if (this.signaturesVues.size <= SIGNATURES_RETENUES) return
    /*
      ⚠️ ON PURGE PAR AGE, PAS AU HASARD. Jeter la plus ancienne garde la
         protection la ou elle sert : sur les signatures encore dans la
         fenetre de validite.
    */
    const limite = maintenant() - FENETRE_MS
    for (const [k, quand] of this.signaturesVues) {
      if (quand < limite) this.signaturesVues.delete(k)
    }
    while (this.signaturesVues.size > SIGNATURES_RETENUES) {
      const premiere = this.signaturesVues.keys().next().value
      this.signaturesVues.delete(premiere)
    }
  }

  // ── Profils ─────────────────────────────────────────────────────────────

  profil(empreinte) {
    if (!empreinte) return null
    return this.profils.get(empreinte) || null
  }

  /**
   * Oublie les profils muets depuis trop longtemps. Rend le compte.
   *
   * ⚠️ SANS CA, LE FICHIER NE FAIT QUE GROSSIR. Un profil par visiteur, pour
   *    toujours : sur un serveur public c'est des dizaines de milliers
   *    d'entrees apres un an, relues et reecrites a chaque demarrage.
   */
  #oublierLesAnciens(maintenantMs = Date.now()) {
    let n = 0
    for (const [empreinte, p] of this.profils) {
      // Un role donne ou une note ecrite sont des decisions : on ne les jette pas.
      if (p.role || (p.notes && String(p.notes).trim())) continue
      const vu = Number(p.vuLaDerniereFois) || 0
      if (vu && maintenantMs - vu > PROFIL_OUBLIE_APRES_MS) {
        this.profils.delete(empreinte)
        n++
      }
    }
    if (n) this.sale = true
    return n
  }

  /** Cree ou met a jour le profil au moment ou le joueur arrive. */
  arrivee(empreinte, nom) {
    if (!empreinte) return null
    let p = this.profils.get(empreinte)
    if (!p) {
      p = {
        empreinte,
        nom,
        noms: [nom],
        vuLaPremiereFois: maintenant(),
        vuLaDerniereFois: maintenant(),
        tempsDeJeuMs: 0,
        sessions: 0,
        role: null,
        notes: '',
      }
      this.profils.set(empreinte, p)
    }
    p.nom = nom
    /*
      ⚠️ ON GARDE LES ANCIENS PSEUDOS. Quelqu'un qui change de nom pour
         echapper a une sanction doit rester reconnaissable — l'empreinte le
         trahit deja, la liste le rend lisible pour l'hote.
    */
    if (!p.noms.includes(nom)) {
      p.noms.unshift(nom)
      p.noms = p.noms.slice(0, 8)
    }
    p.vuLaDerniereFois = maintenant()
    p.sessions++
    this.sale = true
    return p
  }

  /** Ajoute le temps joue au depart du joueur. */
  depart(empreinte, dureeMs) {
    const p = this.profils.get(empreinte)
    if (!p) return
    p.tempsDeJeuMs += Math.max(0, Math.round(dureeMs || 0))
    p.vuLaDerniereFois = maintenant()
    this.sale = true
  }

  /** Pose un role durable sur une identite. `null` le retire. */
  poserRole(empreinte, role) {
    const p = this.profils.get(empreinte)
    if (!p) return false
    p.role = role
    this.sale = true
    return true
  }

  /** Ce qu'on accepte de montrer publiquement d'un profil. */
  publique(empreinte) {
    const p = this.profil(empreinte)
    if (!p) return null
    return {
      empreinte: p.empreinte,
      nom: p.nom,
      depuis: p.vuLaPremiereFois,
      sessions: p.sessions,
      heuresDeJeu: Math.round(p.tempsDeJeuMs / 360_000) / 10,
      role: p.role,
    }
  }

  get nombre() {
    return this.profils.size
  }
}

module.exports = {
  Identites,
  empreinteDe,
  messageASigner,
  lireCle,
  DOMAINE,
  FENETRE_MS,
  LONGUEUR_EMPREINTE,
}
