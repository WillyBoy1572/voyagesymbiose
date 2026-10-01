'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PERCAGE — le cote hote, celui qui est derriere la box
 * ═══════════════════════════════════════════════════════════════════════════
 *  Un serveur heberge a la maison s'annonce a un point de rendez-vous public et
 *  garde son trou ouvert. Quand quelqu'un demande a le joindre, le rendez-vous
 *  lui dit vers qui taper ; il tape, et le chemin s'ouvre dans les deux sens.
 *
 *  ⚠️ ON TAPE DEPUIS LA PRISE DU JEU, PAS UNE AUTRE. C'est tout le principe :
 *     la box associe le port interne du JEU a un port public, et c'est cette
 *     association-la qu'on garde ouverte. Un enregistrement fait depuis une
 *     seconde prise ouvrirait un trou vers un port qui ne sert a rien — et le
 *     client taperait dans le vide sans que rien ne le dise.
 *
 *  ⚠️ ON RETAPE SANS ARRET. Une association de NAT se referme apres trente
 *     secondes a deux minutes de silence. Sans battement, le serveur devient
 *     injoignable alors qu'il tourne.
 *
 *  ⚠️ UN PORT PUBLIC QUI CHANGE, C'EST UN NAT SYMETRIQUE. Si le rendez-vous
 *     nous voit sur un port different d'un battement a l'autre, le percage ne
 *     marchera pas : l'adresse apprise ne vaudra rien pour le client. On le
 *     DIT, au lieu de laisser le joueur croire que ses amis sont fautifs.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Entre deux battements. Assez court pour tenir le NAT le plus pressé. */
const BATTEMENT_MS = 20_000

/** Combien de ports publics differents avant de declarer le NAT symetrique. */
const PORTS_AVANT_VERDICT = 3

/**
 * Ce qu'un refus veut dire, en francais.
 *
 * ⚠️ UN CODE AFFICHE TEL QUEL N'EST PAS UNE EXPLICATION. « rendezvous_aveugle »
 *    dans une console ne dit a personne quoi faire ensuite.
 */
const EXPLICATIONS = {
  plein: 'le point de rendez-vous est plein ; réessaie dans une minute.',
  billet_inconnu: 'ce billet n’existe plus (la partie est fermée, ou le billet a expiré).',
  rendezvous_aveugle:
    'ce point de rendez-vous ne voit pas les vraies adresses de ses visiteurs — ' +
    'il est lui-même derrière un tunnel ou un proxy. Le perçage est impossible par ce ' +
    'chemin : il faut un autre point de rendez-vous, ou rediriger un port sur ta box.',
}

class Percage {
  /**
   * @param {object} config
   * @param {(objet: object, port: number, adresse: string) => void} envoyer
   * @param {(texte: string) => void} [journal]
   */
  constructor(config, envoyer, journal) {
    this.config = config
    this.envoyer = envoyer
    this.journal = journal || (() => {})

    this.actif = Boolean(config.percage && config.rendezvousAdresse)
    this.cible = this.#lireCible(config.rendezvousAdresse)

    /** Le billet remis par le rendez-vous : c'est ce que l'hote partage. */
    this.billet = null
    /** Notre endroit public, tel que le rendez-vous le voit. */
    this.vu = null
    /** Les ports publics observes : s'ils changent, le NAT est symetrique. */
    this.portsVus = new Set()
    this.symetrique = false

    this.minuterie = null
    this.derniereReponse = 0
    this.perces = 0
    this.annonces = 0
    this.plainteFaite = false

    /** Pourquoi le rendez-vous refuse, s'il refuse. `null` tant qu'il accepte. */
    this.refus = null
  }

  #lireCible(brut) {
    if (!brut) return null
    const m = String(brut).match(/^([A-Za-z0-9.\-]{1,253}):(\d{1,5})$/)
    if (!m) return null
    const port = Number.parseInt(m[2], 10)
    if (port < 1 || port > 65535) return null
    return { adresse: m[1], port }
  }

  demarrer(etat) {
    if (!this.actif) return false
    if (!this.cible) {
      this.journal('perçage : RENDEZVOUS_ADRESSE illisible (attendu « hôte:port »).')
      this.actif = false
      return false
    }

    this.etat = etat
    this.journal(`perçage : annonce vers ${this.cible.adresse}:${this.cible.port}`)
    this.battre()
    this.minuterie = setInterval(() => this.battre(), BATTEMENT_MS)
    /*
      ⚠️ `unref` POUR QUE LA MINUTERIE NE RETIENNE PAS LE PROCESSUS. Sans elle,
         un serveur qu'on arrete attendrait le prochain battement avant de
         mourir.
    */
    if (this.minuterie.unref) this.minuterie.unref()
    return true
  }

  arreter() {
    if (this.minuterie) clearInterval(this.minuterie)
    this.minuterie = null
  }

  /** Un battement : on se rappelle au rendez-vous, et le trou reste ouvert. */
  battre() {
    if (!this.actif || !this.cible) return
    const e = this.etat ? this.etat() : {}
    this.annonces++
    this.envoyer(
      {
        t: 'rdv-heberge',
        nom: e.nom ?? null,
        protege: Boolean(e.motDePasse),
        places: e.maxJoueurs ?? null,
        joueurs: e.joueurs ?? null,
      },
      this.cible.port,
      this.cible.adresse,
    )
  }

  /**
   * Un message venu du rendez-vous. Rend `true` s'il nous concerne.
   *
   * ⚠️ ON NE CROIT QUE NOTRE RENDEZ-VOUS. Accepter un `rdv-perce` de n'importe
   *    qui laisserait un inconnu nous faire taper vers une adresse de son
   *    choix — c'est-a-dire se servir du serveur pour envoyer des paquets a
   *    quelqu'un d'autre.
   */
  traiter(message, adresse, port) {
    if (!this.actif || !this.cible) return false
    const duRendezVous = adresse === this.cible.adresse && port === this.cible.port

    switch (message.t) {
      case 'rdv-billet': {
        if (!duRendezVous) return true
        this.derniereReponse = Date.now()
        if (this.billet !== message.billet) {
          this.billet = message.billet
          this.journal(`perçage : billet « ${this.billet} » — c’est ce que tes amis saisissent.`)
        }
        this.#noterEndroit(message.vu)
        return true
      }

      case 'rdv-perce': {
        if (!duRendezVous) return true
        const vers = message.vers
        if (!vers || typeof vers.adresse !== 'string' || !Number.isInteger(vers.port)) return true

        /*
          ⚠️ ON TAPE PLUSIEURS FOIS, PAS UNE. Le premier paquet se perd souvent :
             il part pendant que la box d'en face n'a encore rien ouvert. Quelques
             coups espaces coutent trois octets et font la difference entre
             « ca marche » et « ca marche une fois sur deux ».
        */
        const coups = Math.min(Math.max(Number(message.coups) || 3, 1), 10)
        for (let i = 0; i < coups; i++) {
          setTimeout(() => {
            this.envoyer({ t: 'rdv-salut' }, vers.port, vers.adresse)
          }, i * 120).unref?.()
        }
        this.perces++
        return true
      }

      case 'rdv-refus': {
        if (!duRendezVous) return true
        this.derniereReponse = Date.now()
        const raison = String(message.raison ?? 'sans raison')
        if (this.refus !== raison) {
          this.refus = raison
          this.journal(`perçage refusé par le rendez-vous : ${EXPLICATIONS[raison] ?? raison}`)
        }

        /*
          ⚠️ UN REFUS DEFINITIF DOIT ARRETER LES BATTEMENTS. « Plein » se
             résout tout seul quand une place se libère, donc on continue. Un
             rendez-vous aveugle, lui, ne guérira pas : continuer à lui parler
             toutes les vingt secondes, c'est inonder quelqu'un d'autre pour
             rien, et garder dans l'interface un billet qui n'arrivera jamais.
        */
        if (raison === 'rendezvous_aveugle') {
          this.actif = false
          this.arreter()
        }
        return true
      }

      case 'rdv-salut':
        /*
          Un client qui perce vers nous. Il n'y a rien a faire : le simple fait
          de recevoir prouve que le chemin est ouvert, et son `bonjour` suivra.
        */
        return true

      default:
        return false
    }
  }

  #noterEndroit(vu) {
    if (!vu || typeof vu.adresse !== 'string' || !Number.isInteger(vu.port)) return
    this.vu = vu
    this.portsVus.add(vu.port)

    /*
      ⚠️ PLUSIEURS PORTS PUBLICS = NAT SYMETRIQUE = PERCAGE IMPOSSIBLE. Le dire
         vaut mieux que de laisser le joueur accuser ses amis : avec ce
         diagnostic, il sait qu'il doit rediriger un port ou passer par un
         serveur heberge.
    */
    if (!this.symetrique && this.portsVus.size >= PORTS_AVANT_VERDICT) {
      this.symetrique = true
      this.journal(
        'perçage : ta box change de port à chaque envoi (NAT symétrique). ' +
          'Tes amis ne pourront pas entrer sans redirection de port.',
      )
    }
  }

  rapport() {
    return {
      actif: this.actif,
      rendezvous: this.cible ? `${this.cible.adresse}:${this.cible.port}` : null,
      billet: this.billet,
      vu: this.vu,
      symetrique: this.symetrique,
      refus: this.refus,
      refusExplique: this.refus ? (EXPLICATIONS[this.refus] ?? this.refus) : null,
      annonces: this.annonces,
      perces: this.perces,
      /*
        ⚠️ « JAMAIS REPONDU » N'EST PAS « 0 ». Sans reponse du rendez-vous, on
           ne sait pas si le billet existe — et l'afficher a zero ferait croire
           a un rendez-vous joignable mais vide.
      */
      derniereReponse: this.derniereReponse || null,
    }
  }
}

module.exports = { Percage, BATTEMENT_MS, PORTS_AVANT_VERDICT, EXPLICATIONS }
