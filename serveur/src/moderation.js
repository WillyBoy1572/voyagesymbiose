'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MODERATION — expulser, bannir, museler
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ EXPULSER N'EST PAS BANNIR. Une expulsion ne survit pas a la seconde
 *     suivante : le joueur se reconnecte aussitot. C'est voulu — mais ca veut
 *     dire qu'un hote qui croit avoir regle un probleme ne l'a pas regle. Le
 *     bannissement, lui, s'ecrit sur le disque.
 *
 *  ⚠️ ON BANNIT UNE IDENTITE QUAND ON EN A UNE, UNE ADRESSE SINON. L'adresse
 *     est un mauvais identifiant : elle change, et elle est partagee entre
 *     tous les gens d'une meme maison. On s'en sert quand il n'y a rien de
 *     mieux, et on le dit a l'hote.
 *
 *  ⚠️ UN BANNISSEMENT SANS DATE DE FIN EST DEFINITIF, ET CA SE DECIDE. On
 *     accepte une duree, et on l'affiche : « a vie » doit etre un choix,
 *     jamais un defaut qu'on subit.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Combien de sanctions on garde au maximum, pour que le fichier reste lisible. */
const MAXIMUM = 2000

function maintenant() {
  return Date.now()
}

/** Lit une duree humaine : `30m`, `2h`, `7j`, `0` ou vide = definitif. */
function lireDuree(texte) {
  if (texte === undefined || texte === null || texte === '') return 0
  const t = String(texte).trim().toLowerCase()
  if (t === '0' || t === 'definitif' || t === 'toujours') return 0
  const m = t.match(/^(\d+)\s*([smhjd]?)$/)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const unite = m[2] || 'm'
  const facteurs = { s: 1000, m: 60_000, h: 3_600_000, j: 86_400_000, d: 86_400_000 }
  return n * (facteurs[unite] || 60_000)
}

function decrireDuree(ms) {
  if (!ms) return 'définitif'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `${Math.round(ms / 360_000) / 10} h`
  return `${Math.round(ms / 8_640_000) / 10} j`
}

class Moderation {
  /**
   * @param {object} config
   * @param {(texte: string) => void} [journal]
   * @param {(adresse: string) => boolean} [adressePartagee] vrai si plus d'un
   *   joueur connecté arrive de cette adresse.
   */
  constructor(config, journal, adressePartagee) {
    this.config = config
    this.journal = journal || (() => {})
    this.adressePartagee = adressePartagee || (() => false)
    this.fichier = path.join(config.dossierDonnees, 'moderation.json')
    /** @type {Array<object>} */
    this.sanctions = []
    this.sale = false
    this.#charger()
  }

  #charger() {
    try {
      const brut = JSON.parse(fs.readFileSync(this.fichier, 'utf8'))
      for (const s of brut.sanctions || []) {
        if (!s || typeof s.genre !== 'string') continue
        this.sanctions.push({
          genre: s.genre === 'museler' ? 'museler' : 'bannir',
          empreinte: typeof s.empreinte === 'string' ? s.empreinte : null,
          adresse: typeof s.adresse === 'string' ? s.adresse : null,
          nom: typeof s.nom === 'string' ? s.nom : '?',
          raison: typeof s.raison === 'string' ? s.raison.slice(0, 240) : '',
          par: typeof s.par === 'string' ? s.par : '?',
          pose: Number(s.pose) || maintenant(),
          jusqua: Number(s.jusqua) || 0,
        })
      }
      this.#purger()
      if (this.sanctions.length) this.journal(`${this.sanctions.length} sanction(s) en vigueur.`)
    } catch {
      /* premier demarrage */
    }
  }

  enregistrerSiBesoin() {
    if (!this.sale) return false
    try {
      fs.mkdirSync(path.dirname(this.fichier), { recursive: true })
      const abri = `${this.fichier}.tmp`
      fs.writeFileSync(abri, JSON.stringify({ sanctions: this.sanctions }, null, 2), 'utf8')
      fs.renameSync(abri, this.fichier)
      this.sale = false
      return true
    } catch (e) {
      this.journal(`sanctions non enregistrées : ${e.message}`)
      return false
    }
  }

  /** Retire ce qui a expire, et plafonne la taille. */
  #purger() {
    const t = maintenant()
    const avant = this.sanctions.length
    this.sanctions = this.sanctions.filter((s) => s.jusqua === 0 || s.jusqua > t)
    if (this.sanctions.length > MAXIMUM) {
      this.sanctions = this.sanctions.slice(-MAXIMUM)
    }
    if (this.sanctions.length !== avant) this.sale = true
  }

  balayer() {
    this.#purger()
    this.enregistrerSiBesoin()
  }

  // ── Poser ───────────────────────────────────────────────────────────────

  /**
   * @param {'bannir'|'museler'} genre
   * @param {{empreinte?: string|null, adresse?: string|null, nom?: string}} cible
   */
  poser(genre, cible, { raison = '', par = '?', dureeMs = 0 } = {}) {
    const s = {
      genre,
      empreinte: cible.empreinte || null,
      /*
        ⚠️ UNE ADRESSE PARTAGÉE BANNIT TOUT LE MONDE. Nos serveurs hébergés sont
           joints par un tunnel qui masque la source : ils voient TOUS leurs
           joueurs arriver de `10.90.0.1`. Bannir à l'adresse y fermerait le
           serveur à tout le monde sauf à celui qu'on visait, qui reviendrait
           avec un autre port.

           ⚠️ LE CRITÈRE EST « PARTAGÉE », PAS « PRIVÉE ». Une soirée LAN donne
              des adresses privées mais DISTINCTES, et bannir l'une d'elles est
              parfaitement légitime. Ce qu'on refuse, c'est une adresse derrière
              laquelle se trouve déjà quelqu'un d'autre.
      */
      adresse: cible.empreinte || this.adressePartagee(cible.adresse)
        ? null
        : cible.adresse || null,
      nom: cible.nom || '?',
      raison: String(raison || '').slice(0, 240),
      par: String(par || '?').slice(0, 24),
      pose: maintenant(),
      jusqua: dureeMs > 0 ? maintenant() + dureeMs : 0,
    }
    /*
      ⚠️ UNE SANCTION SANS CIBLE NE SANCTIONNE PERSONNE, ET PIRE : une entree
         avec empreinte et adresse nulles correspondrait a tout le monde au
         prochain test. On refuse.
    */
    if (!s.empreinte && !s.adresse) return null
    this.sanctions.push(s)
    this.sale = true
    this.enregistrerSiBesoin()
    return s
  }

  /** Retire toutes les sanctions d'un genre visant cette cible. Rend le compte. */
  lever(genre, cle) {
    const c = String(cle || '').toLowerCase()
    const avant = this.sanctions.length
    this.sanctions = this.sanctions.filter((s) => {
      if (s.genre !== genre) return true
      const corresp =
        (s.empreinte && s.empreinte.toLowerCase() === c) ||
        (s.adresse && s.adresse.toLowerCase() === c) ||
        (s.nom && s.nom.toLowerCase() === c)
      return !corresp
    })
    const retirees = avant - this.sanctions.length
    if (retirees) {
      this.sale = true
      this.enregistrerSiBesoin()
    }
    return retirees
  }

  // ── Interroger ──────────────────────────────────────────────────────────

  #trouver(genre, empreinte, adresse) {
    const t = maintenant()
    for (const s of this.sanctions) {
      if (s.genre !== genre) continue
      if (s.jusqua !== 0 && s.jusqua <= t) continue
      if (s.empreinte && empreinte && s.empreinte === empreinte) return s
      if (s.adresse && adresse && s.adresse === adresse) return s
    }
    return null
  }

  /** Rend la sanction qui interdit l'arrivee, ou `null`. */
  banni(empreinte, adresse) {
    return this.#trouver('bannir', empreinte, adresse)
  }

  /** Rend la sanction qui interdit de parler, ou `null`. */
  musele(empreinte, adresse) {
    return this.#trouver('museler', empreinte, adresse)
  }

  liste(genre = null) {
    const t = maintenant()
    return this.sanctions
      .filter((s) => (!genre || s.genre === genre) && (s.jusqua === 0 || s.jusqua > t))
      .map((s) => ({
        genre: s.genre,
        cible: s.empreinte || s.adresse,
        parQuoi: s.empreinte ? 'identité' : 'adresse',
        nom: s.nom,
        raison: s.raison,
        par: s.par,
        pose: s.pose,
        jusqua: s.jusqua,
        reste: s.jusqua ? decrireDuree(s.jusqua - t) : 'définitif',
      }))
  }

  get nombre() {
    return this.sanctions.length
  }
}

module.exports = { Moderation, lireDuree, decrireDuree }
