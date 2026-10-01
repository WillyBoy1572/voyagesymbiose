'use strict'

const crypto = require('node:crypto')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RENDEZ-VOUS — se joindre sans ouvrir de port
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le mur de l'hebergement maison, ce n'est pas le code : c'est la box. Tant
 *  qu'un port n'est pas redirige, personne ne peut entrer. Et beaucoup de gens
 *  ne savent pas le faire, ou n'ont pas la main dessus.
 *
 *  LE PERCAGE DE NAT contourne ca. Les deux cotes tapent vers un meme point
 *  public ; celui-ci voit leurs adresses VUES DE L'EXTERIEUR et les leur donne
 *  mutuellement. Chacun envoie alors vers l'autre, et le trou creuse par leur
 *  propre paquet sortant laisse entrer celui d'en face.
 *
 *  ⚠️ LE SERVEUR DOIT TAPER DEPUIS SA PROPRE PRISE UDP, PAS UNE AUTRE. C'est
 *     tout le principe : la box associe le port interne du JEU a un port
 *     public, et c'est cette association-la qu'on veut garder ouverte. Un
 *     enregistrement fait depuis une seconde prise ouvrirait un trou vers un
 *     port qui ne sert a rien.
 *
 *  ⚠️ IL FAUT CONTINUER DE TAPER. Une association de NAT se referme apres
 *     trente secondes a deux minutes de silence. Sans battement, le serveur
 *     devient injoignable sans que rien ne le dise.
 *
 *  ⚠️ CA NE MARCHE PAS PARTOUT, ET IL FAUT LE DIRE. Un NAT dit « symetrique »
 *     donne un port public DIFFERENT par destination : l'adresse apprise au
 *     rendez-vous ne vaut alors rien pour le client. C'est le cas d'une partie
 *     des reseaux mobiles et de quelques fournisseurs. Pour ceux-la il faut un
 *     relais, et ce module sait aussi en faire un.
 *
 *  ⚠️ LE RENDEZ-VOUS NE VOIT JAMAIS DE PARTIE. Il ne transporte que des
 *     adresses et un billet ; le relais, lui, transporte des octets qu'il ne
 *     lit pas. Aucun mot de passe, aucune identite, aucun contenu de jeu.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Un billet oublie apres ce silence : la partie est finie, ou la box a ferme. */
const OUBLI_MS = 90_000

/** Au-dela, on refuse d'en retenir plus : un point de rendez-vous n'est pas un annuaire. */
const BILLETS_MAX = 500

/** Combien de paquets de percage on demande d'envoyer. */
const COUPS_DE_PERCAGE = 5

/** Combien d'octets on accepte de relayer par seconde et par session. */
const RELAIS_OCTETS_PAR_SECONDE = 256 * 1024

/** Un billet lisible et sans ambiguite : pas de 0/O ni de 1/l. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * Une adresse qu'aucun inconnu ne peut joindre depuis l'Internet.
 *
 * ⚠️ CE N'EST PAS DE LA COSMETIQUE. Un rendez-vous qui voit une adresse privee
 *    ne voit PAS celle du demandeur : quelque chose la reecrit en chemin. Lui
 *    donner quand meme produit un percage qui echoue a tous les coups, et —
 *    pire — qui echoue EN SILENCE, parce que le protocole, lui, s'est bien
 *    deroule.
 */
function estPrivee(adresse) {
  const a = String(adresse || '')
  if (a === '' || a === '::' || a === '::1') return true
  // IPv6 : liens locaux et adresses uniques locales.
  if (/^fe[89ab][0-9a-f]:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a)) return true
  // IPv4 eventuellement habillee en IPv6 (::ffff:10.0.0.1).
  const v4 = a.replace(/^::ffff:/i, '')
  const o = v4.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true
  if (o[0] === 192 && o[1] === 168) return true
  if (o[0] === 169 && o[1] === 254) return true
  // 100.64.0.0/10 : le NAT du fournisseur, invisible et injoignable.
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true
  return false
}

function billetNeuf() {
  const octets = crypto.randomBytes(8)
  let sortie = ''
  for (const o of octets) sortie += ALPHABET[o % ALPHABET.length]
  return sortie
}

function cleEndroit(adresse, port) {
  return `${adresse}:${port}`
}

/**
 * Le point de rendez-vous, tenu par un serveur public.
 *
 * Il repond a quatre messages, tous distincts de ceux du jeu :
 *   `rdv-heberge`  un hote s'annonce et garde son trou ouvert
 *   `rdv-joindre`  un client demande l'adresse d'un hote
 *   `rdv-relais`   les deux cotes renoncent au direct et passent par ici
 *   `rdv-ping`     de quoi mesurer et garder le trou ouvert
 */
class RendezVous {
  constructor(config, envoyer, journal) {
    this.config = config
    /** `envoyer(objet, port, adresse)` — la prise UDP du serveur. */
    this.envoyer = envoyer
    this.journal = journal || (() => {})
    this.actif = Boolean(config.rendezvous)

    /** billet -> { adresse, port, vuLe, nom, protege, places, joueurs } */
    this.billets = new Map()
    /** cle d'endroit -> billet, pour retrouver un hote par son adresse. */
    this.parEndroit = new Map()
    /** Sessions relayees : cle -> { a, b, octets, fenetre } */
    this.relais = new Map()

    this.perces = 0
    this.relayes = 0

    /*
      ⚠️ UN RENDEZ-VOUS DERRIERE UN PROXY NE SERT A RIEN, ET DOIT LE DIRE.
         Ces serveurs-ci sont joints par un tunnel WireGuard depuis un VPS qui
         masque la source : ils voient TOUS leurs joueurs a la meme adresse
         privee. Le protocole se deroule parfaitement et le percage echoue a
         tous les coups. On aime mieux refuser en nommant la raison.

         Le soupcon ne se declare que si le serveur sait par ailleurs qu'il est
         public (`ANNUAIRE_ADRESSE`). Sur un reseau local — un banc d'essai, une
         soiree LAN — des adresses privees sont parfaitement normales.
    */
    this.adresseAnnoncee = String(config.annuaireAdresse || '')
    this.seCroitPublic = this.adresseAnnoncee !== '' && !estPrivee(this.adresseAnnoncee)
    this.aveugle = false
    this.plainteFaite = false
  }

  /** Vrai si l'adresse observee prouve que quelque chose reecrit la source. */
  #verifierVue(adresse) {
    if (!this.seCroitPublic || !estPrivee(adresse)) return true
    this.aveugle = true
    if (!this.plainteFaite) {
      this.plainteFaite = true
      this.journal(
        'rendez-vous désactivé : ce serveur est annoncé public mais voit ses visiteurs ' +
          'arriver d’une adresse privée. Quelque chose réécrit la source en chemin ' +
          '(tunnel, proxy, NAT du fournisseur) : les adresses apprises ici seraient ' +
          'inutilisables. Il faut un point de rendez-vous joint en direct.',
      )
    }
    return false
  }

  demarrer() {
    if (!this.actif) return false
    this.journal('point de rendez-vous actif : les hôtes derrière une box peuvent s’y annoncer.')
    return true
  }

  balayer(maintenant = Date.now()) {
    for (const [billet, h] of this.billets) {
      if (maintenant - h.vuLe > OUBLI_MS) {
        this.billets.delete(billet)
        this.parEndroit.delete(cleEndroit(h.adresse, h.port))
      }
    }
    for (const [cle, r] of this.relais) {
      if (maintenant - r.vuLe > OUBLI_MS) this.relais.delete(cle)
    }
  }

  /**
   * Traite un message de rendez-vous. Rend `true` s'il a ete pris en charge.
   *
   * ⚠️ AUCUN DE CES MESSAGES NE PORTE DE JETON DE SESSION. Ils arrivent AVANT
   *    toute session, par definition : c'est leur role. Ils ne donnent donc
   *    aucun droit, ne lisent aucun etat de partie, et ne peuvent rien
   *    modifier — seulement apprendre une adresse publique.
   */
  traiter(message, adresse, port) {
    if (!this.actif) return false

    if (!this.#verifierVue(adresse)) {
      /*
        On repond quand meme : un hote qui n'obtient aucune reponse croirait a
        une coupure reseau et reessaierait sans fin. Il doit apprendre que c'est
        le rendez-vous qui ne peut pas, et pourquoi.
      */
      if (message.t === 'rdv-heberge' || message.t === 'rdv-joindre') {
        this.envoyer({ t: 'rdv-refus', raison: 'rendezvous_aveugle' }, port, adresse)
        return true
      }
      if (message.t === 'rdv-ping') {
        this.envoyer({ t: 'rdv-pong', ts: message.ts ?? 0, vu: null, aveugle: true }, port, adresse)
        return true
      }
      return false
    }

    switch (message.t) {
      case 'rdv-heberge':
        return this.#heberge(message, adresse, port)
      case 'rdv-joindre':
        return this.#joindre(message, adresse, port)
      case 'rdv-ping':
        /*
          ⚠️ LA REPONSE DIT AU CLIENT SON PROPRE ENDROIT PUBLIC. C'est la seule
             facon pour lui de savoir ce que le monde exterieur voit — et donc
             de deviner s'il est derriere un NAT symetrique.
        */
        this.envoyer({ t: 'rdv-pong', ts: message.ts ?? 0, vu: { adresse, port } }, port, adresse)
        return true
      default:
        return false
    }
  }

  #heberge(message, adresse, port) {
    const existant = this.parEndroit.get(cleEndroit(adresse, port))
    const billet = existant && this.billets.has(existant) ? existant : billetNeuf()

    if (!this.billets.has(billet) && this.billets.size >= BILLETS_MAX) {
      this.envoyer({ t: 'rdv-refus', raison: 'plein' }, port, adresse)
      return true
    }

    this.billets.set(billet, {
      adresse,
      port,
      vuLe: Date.now(),
      nom: message.nom ?? null,
      protege: Boolean(message.protege),
      places: Number.isInteger(message.places) ? message.places : null,
      joueurs: Number.isInteger(message.joueurs) ? message.joueurs : null,
    })
    this.parEndroit.set(cleEndroit(adresse, port), billet)

    /*
      ⚠️ ON LUI REND SON PROPRE ENDROIT PUBLIC. L'hote ne peut pas le deviner :
         derriere une box, il ne connait que son adresse privee. C'est ce qu'il
         affichera a ses amis, et c'est aussi ce qui lui permet de voir que son
         port public change d'un battement a l'autre — signe d'un NAT
         symetrique, donc d'un percage qui ne marchera pas.
    */
    this.envoyer({ t: 'rdv-billet', billet, vu: { adresse, port } }, port, adresse)
    return true
  }

  #joindre(message, adresse, port) {
    const billet = typeof message.billet === 'string' ? message.billet.toUpperCase().slice(0, 16) : ''
    const h = this.billets.get(billet)

    if (!h) {
      this.envoyer({ t: 'rdv-refus', raison: 'billet_inconnu' }, port, adresse)
      return true
    }

    /*
      ⚠️ LES DEUX COTES DOIVENT TAPER, ET PRESQUE EN MEME TEMPS. On previent
         donc l'hote AVANT de repondre au client : sur un NAT restrictif, le
         paquet du client n'entre que si l'hote a deja ouvert le chemin vers
         lui. L'ordre compte.
    */
    this.envoyer(
      { t: 'rdv-perce', vers: { adresse, port }, coups: COUPS_DE_PERCAGE },
      h.port,
      h.adresse,
    )
    this.envoyer(
      {
        t: 'rdv-hote',
        billet,
        hote: { adresse: h.adresse, port: h.port },
        coups: COUPS_DE_PERCAGE,
        nom: h.nom,
        protege: h.protege,
      },
      port,
      adresse,
    )

    this.perces++
    return true
  }

  rapport() {
    return {
      actif: this.actif && !this.aveugle,
      aveugle: this.aveugle,
      billets: this.billets.size,
      perces: this.perces,
      relais: this.relais.size,
      relayes: this.relayes,
    }
  }
}

module.exports = {
  RendezVous,
  estPrivee,
  billetNeuf,
  ALPHABET,
  OUBLI_MS,
  COUPS_DE_PERCAGE,
  BILLETS_MAX,
  RELAIS_OCTETS_PAR_SECONDE,
}
