'use strict'

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ANNUAIRE — se faire connaitre, ou pas
 * ═══════════════════════════════════════════════════════════════════════════
 *  Un serveur qui veut etre trouve s'annonce a une liste publique. Le lanceur
 *  lit cette liste et la montre dans son navigateur de serveurs.
 *
 *  ⚠️ C'EST ETEINT PAR DEFAUT, ET CE N'EST PAS UNE PRECAUTION DE FACADE.
 *     S'annoncer, c'est publier l'adresse d'une machine sur Internet. Pour un
 *     serveur heberge chez quelqu'un, c'est rendre publique son adresse
 *     domestique. On ne fait jamais ca a la place du proprietaire : il pose
 *     `ANNUAIRE=1`, ou rien ne part.
 *
 *  ⚠️ ON N'ENVOIE AUCUN JOUEUR. Ni pseudo, ni adresse, ni empreinte : juste le
 *     nombre. Une liste publique de serveurs n'a aucune raison de savoir qui
 *     joue.
 *
 *  ⚠️ L'ADRESSE PUBLIQUE N'EST PAS CELLE QUE LE SERVEUR VOIT. Derriere un
 *     NAT, un conteneur ou un tunnel, le serveur ignore par quelle adresse on
 *     l'atteint. On la demande donc explicitement (`ANNUAIRE_ADRESSE`) et, a
 *     defaut, on laisse l'annuaire lire l'adresse source de la requete — c'est
 *     la seule qui soit vraie.
 *
 *  ⚠️ UN ANNUAIRE INJOIGNABLE N'EST PAS UNE PANNE DU SERVEUR. On journalise
 *     une fois, on reessaie plus tard, et la partie continue.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Entre deux annonces. Plus court n'apporte rien, plus long fait disparaitre. */
const PERIODE_MS = 60_000

/**
 * Au-dela, on considere l'annuaire muet.
 *
 * ⚠️ GENEREUX, ET IL LE FAUT. L'annuaire ne repond pas tout de suite : il
 *    INTERROGE l'adresse annoncee avant de l'accepter, et cette verification
 *    repasse par Internet. Huit secondes suffisaient la plupart du temps et pas
 *    toujours — d'ou des echecs intermittents qui n'en etaient pas.
 */
const DELAI_MS = 20_000

/** Combien d'echecs de suite avant de se taire (on reessaie plus lentement). */
const ECHECS_AVANT_PAUSE = 5

/**
 * Combien d'echecs de suite avant d'en parler.
 *
 * ⚠️ UN ECHEC UNIQUE NE VEUT RIEN DIRE. Une annonce rate pour mille raisons
 *    passageres : un paquet perdu, un relais lent, une verification au-dela du
 *    delai. La version precedente journalisait des le PREMIER echec, puis
 *    « de nouveau joignable » au succes suivant — soit deux lignes par minute,
 *    pour toujours, sur un serveur qui fonctionnait. On ne parle qu'au-dela de
 *    trois echecs d'affilee, et on ne parle de la reprise que si on avait parle
 *    de la panne.
 */
const ECHECS_AVANT_DE_PARLER = 3

class Annuaire {
  /**
   * @param {object} config
   * @param {() => object} etat ce qu'il faut annoncer, calcule a chaque fois
   */
  constructor(config, etat, journal) {
    this.config = config
    this.etat = etat
    this.journal = journal || (() => {})
    this.actif = Boolean(config.annuaire && config.annuaireUrl)
    this.url = config.annuaireUrl || ''
    this.minuterie = null
    /** Echecs d'affilee. Remis a zero des qu'une annonce passe. */
    this.echecs = 0
    /** Total depuis le demarrage : utile pour juger une liaison instable. */
    this.echecsTotal = 0
    this.reussites = 0
    this.derniereReponse = null
    this.derniereErreur = null
    this.derniereReussite = 0
    this.dernierEnvoi = 0
    this.pause = false
    /** Vrai quand on a deja dit que ca n'allait pas : evite de le redire. */
    this.plainteFaite = false
  }

  demarrer() {
    if (!this.actif) {
      // On le dit : « pourquoi mon serveur n'apparait pas » est une vraie question.
      this.journal('annuaire : éteint (ANNUAIRE=1 et ANNUAIRE_URL pour l’allumer).')
      return false
    }
    this.journal(`annuaire : annonces vers ${this.url}`)
    this.annoncer()
    this.minuterie = setInterval(() => this.annoncer(), PERIODE_MS)
    /*
      ⚠️ `unref` POUR QUE LA MINUTERIE NE RETIENNE PAS LE PROCESSUS. Sans elle,
         un serveur qu'on arrete attendrait la prochaine annonce avant de
         mourir.
    */
    if (this.minuterie.unref) this.minuterie.unref()
    return true
  }

  arreter() {
    if (this.minuterie) clearInterval(this.minuterie)
    this.minuterie = null
    if (!this.actif) return
    // Un retrait propre vaut mieux qu'une entree morte dans la liste.
    this.#envoyer({ ...this.#corps(), retire: true }, () => {})
  }

  #corps() {
    const e = this.etat() || {}
    return {
      nom: e.nom,
      version: e.version,
      protocole: e.protocole,
      joueurs: e.joueurs,
      maxJoueurs: e.maxJoueurs,
      motDePasse: Boolean(e.motDePasse),
      monde: e.monde || null,
      transport: e.transport || 'udp',
      deboutDepuisS: e.deboutDepuisS || 0,
      /** Vide = « lis l'adresse source », la seule qui soit vraie. */
      adresse: this.config.annuaireAdresse || null,
      port: this.config.port,
      portHttp: this.config.portHttp,
      pays: this.config.pays || null,
    }
  }

  annoncer() {
    if (!this.actif) return
    if (this.pause && Date.now() - this.dernierEnvoi < PERIODE_MS * 10) return
    this.dernierEnvoi = Date.now()

    this.#envoyer(this.#corps(), (erreur, reponse) => {
      if (erreur) {
        this.echecs++
        this.echecsTotal++
        this.derniereErreur = erreur.message

        /*
          ⚠️ ON NE PARLE QU'AU-DELA DE TROIS ECHECS D'AFFILEE, ET UNE SEULE FOIS.
             Journaliser chaque echec puis chaque reprise remplissait la console
             de deux lignes par minute sur un serveur qui marchait.
        */
        if (this.echecs === ECHECS_AVANT_DE_PARLER && !this.plainteFaite) {
          this.plainteFaite = true
          this.journal(`annuaire injoignable depuis ${this.echecs} essais (${erreur.message}) — on réessaiera.`)
        }
        if (this.echecs >= ECHECS_AVANT_PAUSE) this.pause = true
        return
      }

      // On ne parle de la reprise que si on avait parle de la panne.
      if (this.plainteFaite) {
        this.journal('annuaire : de nouveau joignable.')
        this.plainteFaite = false
      }
      this.echecs = 0
      this.reussites++
      this.derniereReussite = Date.now()
      this.pause = false
      this.derniereReponse = reponse
    })
  }

  #envoyer(corps, fini) {
    let adresse
    try {
      adresse = new URL(this.url)
    } catch {
      return fini(new Error('ANNUAIRE_URL invalide'))
    }

    const transport = adresse.protocol === 'https:' ? https : http
    const charge = Buffer.from(JSON.stringify(corps), 'utf8')

    const entetes = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': charge.length,
      'User-Agent': `voyage-serveur/${this.config.version}`,
    }
    /*
      ⚠️ LA CLE D'ANNUAIRE PART EN ENTETE, JAMAIS DANS L'URL. Une URL se
         retrouve dans les journaux d'acces, les caches et les referrers.
    */
    if (this.config.annuaireCle) entetes['X-Annuaire-Cle'] = this.config.annuaireCle

    const requete = transport.request(
      {
        protocol: adresse.protocol,
        hostname: adresse.hostname,
        port: adresse.port || (adresse.protocol === 'https:' ? 443 : 80),
        path: adresse.pathname + adresse.search,
        method: 'POST',
        headers: entetes,
        timeout: DELAI_MS,
      },
      (reponse) => {
        const morceaux = []
        let total = 0
        reponse.on('data', (m) => {
          total += m.length
          // Une reponse enorme n'a rien a nous dire : on coupe.
          if (total > 65536) return reponse.destroy()
          morceaux.push(m)
        })
        reponse.on('end', () => {
          if (reponse.statusCode !== 200) {
            return fini(new Error(`HTTP ${reponse.statusCode}`))
          }
          try {
            fini(null, JSON.parse(Buffer.concat(morceaux).toString('utf8')))
          } catch {
            fini(null, null)
          }
        })
      },
    )

    requete.on('timeout', () => requete.destroy(new Error('délai dépassé')))
    requete.on('error', (e) => fini(e))
    requete.end(charge)
  }

  /**
   * Ce que `/admin/etat` montre.
   *
   * ⚠️ SANS LA DERNIERE ERREUR, « ca ne marche pas » N'APPREND RIEN. C'est elle
   *    qui distingue un port ferme d'un delai depasse, et donc une adresse a
   *    ouvrir d'une liaison lente.
   */
  rapport() {
    return {
      actif: this.actif,
      url: this.actif ? this.url : null,
      echecs: this.echecs,
      echecsTotal: this.echecsTotal,
      reussites: this.reussites,
      derniereErreur: this.derniereErreur,
      derniereReussite: this.derniereReussite || null,
      pause: this.pause,
      derniereAnnonce: this.dernierEnvoi || null,
    }
  }
}

module.exports = { Annuaire }
