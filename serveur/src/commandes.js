'use strict'

const { lireDuree, decrireDuree } = require('./moderation')
const { GESTES } = require('./evenements')
const transport = require('./transport')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  COMMANDES DE CHAT
 * ═══════════════════════════════════════════════════════════════════════════
 *  Un registre, une fonction par commande. Ajouter une commande = ajouter une
 *  entree ici, rien d'autre a toucher. Une ressource peut en ajouter aussi,
 *  sans toucher a ce fichier.
 *
 *  ⚠️ LE DROIT EST VERIFIE ICI, PAS DANS L'APPELANT. Une commande qui change
 *     la meteo ou bannit quelqu'un ne doit jamais dependre du bon vouloir du
 *     code qui l'appelle. Chaque entree declare la permission qu'elle exige,
 *     et le lanceur ne voit que celles auxquelles il a droit.
 *
 *  ⚠️ UNE COMMANDE INCONNUE REPOND, elle ne disparait pas en silence. Un
 *     joueur qui tape /meteos doit savoir qu'il s'est trompe, sinon il croit
 *     que le serveur est casse.
 *
 *  ⚠️ UNE COMMANDE QUI PLANTE N'EMPORTE PAS LE SERVEUR. Tout est enveloppe, et
 *     l'erreur revient au joueur plutot que dans la console.
 */

const { T, langueValide } = require('./langues')

/*
  ⚠️ UNE SEULE LANGUE A LA FOIS, ET C'EST CELLE DU JOUEUR QUI A TAPE. Chaque
     commande est un appel synchrone depuis `executer()` : on pose la langue
     avant, on la lit pendant, et personne d'autre ne tourne entre-temps. Ca
     evite de passer la langue a cinquante fonctions qui ne font que la
     transmettre.

  ⚠️ SI UN JOUR UNE COMMANDE DEVIENT `async`, CECI CASSE : deux commandes
     entrelacees liraient la langue de l'autre. Le jour ou ca arrive, il faudra
     passer `t` en argument -- et ce commentaire est la pour qu'on le sache
     avant de le decouvrir sur un serveur ou deux joueurs parlent deux langues.
*/
let langueCourante = 'fr'

/** Le texte, dans la langue du joueur qui a lance la commande. */
function t(cle, valeurs) {
  return T(langueCourante, cle, valeurs)
}

function distance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Le cap d'un point par rapport a un autre, en points cardinaux.
 *
 * ⚠️ UN RADAR DESSINE EST HORS DE PORTEE DU LUA D'UE4SS : il n'y a pas d'API
 *    de rendu. Un cap et une distance en texte donnent la meme information
 *    utile — « Alex, 120 m, nord-est » — et ca, on sait l'afficher.
 */
/*
  ⚠️ LES POINTS CARDINAUX SONT AFFICHES, DONC TRADUITS. Ce ne sont pas des
     identifiants : personne ne tape « nord-est » dans une commande. La meteo et
     les gestes, eux, SE TAPENT (`/meteo orage`) -- ceux-la restent tels quels,
     sinon la commande cesserait de marcher dans les deux autres langues.
*/
const CARDINAUX = [
  'cmd.cap.n',
  'cmd.cap.ne',
  'cmd.cap.e',
  'cmd.cap.se',
  'cmd.cap.s',
  'cmd.cap.so',
  'cmd.cap.o',
  'cmd.cap.no',
]

function cap(de, vers) {
  const dx = vers.x - de.x
  const dy = vers.y - de.y
  // Dans Unreal, X va vers le nord et Y vers l'est.
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle < 0) angle += 360
  const index = Math.round(angle / 45) % 8
  return t(CARDINAUX[index])
}

/** Retrouve un joueur par nom, meme partiel, sans ambiguite. */
function trouverJoueur(session, morceau) {
  const cible = morceau.toLowerCase()
  const exact = [...session.joueurs.values()].find((j) => j.nom.toLowerCase() === cible)
  if (exact) return exact
  const partiels = [...session.joueurs.values()].filter((j) => j.nom.toLowerCase().includes(cible))
  return partiels.length === 1 ? partiels[0] : null
}

const COMMANDES = {
  // ── Pour tout le monde ──────────────────────────────────────────────────

  aide: {
    aide: t('cmd.aide.aide'),
    droit: 'commande',
    faire(session, joueur, args) {
      const sujet = (args[0] ?? '').toLowerCase().replace(/^\//, '')
      if (sujet && COMMANDES[sujet]) {
        return t('cmd.texte', { v1: sujet, v2: COMMANDES[sujet].aide })
      }
      const noms = Object.entries(COMMANDES)
        .filter(([, c]) => session.peut(joueur, c.droit || 'commande'))
        .map(([n]) => `/${n}`)
      if (session.ressources) {
        for (const c of session.ressources.toutesLesCommandes()) noms.push(`/${c.nom}`)
      }
      return t('cmd.commandes-aide-commande-pour-le', { v1: noms.length, v2: noms.join('  ') })
    },
  },

  moi: {
    aide: t('cmd.ton-identite-ton-role-ton'),
    droit: 'commande',
    faire(session, joueur) {
      const bouts = [t('cmd.role', { v1: joueur.nom, v2: session.role(joueur) })]
      bouts.push(joueur.empreinte ? t('cmd.identite', { v1: joueur.empreinte }) : t('cmd.anonyme-pas-d-identite-signee'))
      if (session.identites && joueur.empreinte) {
        const p = session.identites.publique(joueur.empreinte)
        if (p) bouts.push(t('cmd.sessions-heures', { v1: p.sessions, v2: p.heuresDeJeu }))
      }
      const eq = session.equipes ? session.equipes.equipeDe(joueur.id) : null
      if (eq) bouts.push(t('cmd.equipe', { v1: eq.nom }))
      bouts.push(`${joueur.ping} ms`)
      return bouts.join(' · ')
    },
  },

  version: {
    aide: t('cmd.aide.serveur'),
    droit: 'commande',
    faire(session) {
      const choix = transport.choisir()
      return t('cmd.serveur-v-protocole-min-transport', { v1: session.config.nom, v2: session.config.version, v3: session.config.protocole, v4: session.config.protocoleMinimum, v5: choix.nom })
    },
  },

  joueurs: {
    aide: t('cmd.qui-est-connecte'),
    droit: 'commande',
    faire(session) {
      const liste = [...session.joueurs.values()]
        .map((j) => {
          const marques = []
          if (j.hote) marques.push(t('cmd.hote'))
          if (j.spectateur) marques.push('spectateur')
          const r = session.role(j)
          if (r !== 'joueur' && r !== 'hote' && r !== 'spectateur') marques.push(r)
          return t('cmd.ms', { v1: j.nom, v2: marques.length ? ` (${marques.join(', ')})` : '', v3: j.ping })
        })
        .join(' · ')
      return `${session.nombreJouant}/${session.config.maxJoueurs} : ${liste}`
    },
  },

  ou: {
    aide: t('cmd.aide.ou'),
    droit: 'commande',
    faire(session, joueur) {
      const { x, y, z } = joueur.pos
      return t('cmd.tu-es-a', { v1: x.toFixed(0), v2: y.toFixed(0), v3: z.toFixed(0) })
    },
  },

  pres: {
    aide: t('cmd.qui-est-autour-de-toi'),
    droit: 'commande',
    faire(session, joueur, args) {
      const rayon = Math.min(Math.max(Number.parseInt(args[0], 10) || 100, 1), 10_000)
      const autour = [...session.joueurs.values()]
        .filter((j) => j.id !== joueur.id)
        .map((j) => ({ j, d: distance(joueur.pos, j.pos) }))
        .filter((e) => e.d <= rayon * 100)
        .sort((a, b) => a.d - b.d)
      if (autour.length === 0) return t('cmd.personne-a-moins-de-m', { v1: rayon })
      return autour.map((e) => t('cmd.a-m', { v1: e.j.nom, v2: (e.d / 100).toFixed(0) })).join(' · ')
    },
  },

  cap: {
    aide: t('cmd.aide.radar'),
    droit: 'commande',
    faire(session, joueur) {
      const autres = [...session.joueurs.values()]
        .filter((j) => j.id !== joueur.id && !j.spectateur)
        .map((j) => ({ j, d: distance(joueur.pos, j.pos), c: cap(joueur.pos, j.pos) }))
        .sort((a, b) => a.d - b.d)
      if (autres.length === 0) return t('cmd.tu-es-seul-en-jeu')
      return autres.map((e) => t('cmd.m', { v1: e.j.nom, v2: (e.d / 100).toFixed(0), v3: e.c })).join(' · ')
    },
  },

  rdv: {
    aide: t('cmd.aide.rdv'),
    droit: 'rdv',
    faire(session, joueur, args) {
      const sv = session.sauvegardes
      if (!sv) return t('cmd.le-serveur-ne-retient-rien')

      if ((args[0] ?? '').toLowerCase() === 'poser') {
        const r = sv.poserRendezVous(joueur.nom, joueur.pos, joueur.rot)
        /*
          ⚠️ TOUT LE MONDE EST PREVENU TOUT DE SUITE. Un point pose en
             silence ne sert a personne : c'est justement quand quelqu'un
             arrive qu'il doit savoir ou aller.
        */
        session.diffuser({ t: 'rdv', rdv: r })
        session.messageATous(t('cmd.a-pose-le-point-de', { v1: joueur.nom }))
        return null
      }

      if ((args[0] ?? '').toLowerCase() === 'oublier') {
        sv.oublierRendezVous()
        session.diffuser({ t: 'rdv', rdv: null })
        return t('cmd.point-de-rendez-vous-oublie')
      }

      const r = sv.pointDeRendezVous()
      if (!r) return t('cmd.aucun-point-de-rendez-vous')

      const d = distance(joueur.pos, r.pos) / 100
      return t('cmd.rendez-vous-pose-par-a', { v1: r.parQui, v2: d.toFixed(0), v3: cap(joueur.pos, r.pos) })
    },
  },

  marquer: {
    aide: t('cmd.poser-un-repere-ici-nom'),
    droit: 'marquer',
    faire(session, joueur, args) {
      const r = session.monde.poserRepere(joueur.pos, args.join(' '), joueur.nom)
      if (!r) return t('cmd.impossible-trop-de-reperes-sur')
      session.messageATous(t('cmd.a-pose-le-repere-n', { v1: joueur.nom, v2: r.libelle, v3: r.id }))
      return null
    },
  },

  reperes: {
    aide: t('cmd.la-liste-des-reperes'),
    droit: 'commande',
    faire(session, joueur) {
      const liste = [...session.monde.reperes.values()]
      if (liste.length === 0) return t('cmd.aucun-repere-pour-l-instant')
      return liste
        .map((r) => t('cmd.n-m', { v1: r.id, v2: r.libelle, v3: (distance(joueur.pos, r.pos) / 100).toFixed(0), v4: cap(joueur.pos, r.pos) }))
        .slice(0, 20)
        .join(' · ')
    },
  },

  geste: {
    aide: t('cmd.aide.geste', { v1: GESTES.join(', ') }),
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.evenements) return t('cmd.les-gestes-ne-sont-pas')
      const quoi = (args[0] ?? '').toLowerCase()
      if (!GESTES.includes(quoi)) return t('cmd.au-choix', { v1: GESTES.join(', ') })
      const e = session.evenements.preparer(joueur, { genre: 'geste', valeur: quoi })
      if (!e) return t('cmd.doucement-trop-de-gestes-d')
      session.diffuserAutour(e)
      return null
    },
  },

  mp: {
    aide: t('cmd.message-prive-nom-texte'),
    droit: 'parler',
    faire(session, joueur, args) {
      if (args.length < 2) return t('cmd.donne-un-nom-et-un')
      const cible = trouverJoueur(session, args[0])
      if (!cible) return t('cmd.personne-de-ce-nom-ou')
      if (cible.id === joueur.id) return t('cmd.tu-te-parles-deja-tout')
      const texte = args.slice(1).join(' ')
      session.envoyerA(cible, { t: 'chat', canal: 'prive', de: joueur.nom, id: joueur.id, texte })
      return t('cmd.prive-a', { v1: cible.nom, v2: texte })
    },
  },

  // ── Equipes ─────────────────────────────────────────────────────────────

  equipe: {
    aide: t('cmd.equipes-equipe-equipe-creer-nom'),
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.equipes) return t('cmd.les-equipes-ne-sont-pas')
      const quoi = (args[0] ?? '').toLowerCase()
      const nom = args.slice(1).join(' ')

      if (!quoi) {
        const vue = session.equipes.instantane().equipes
        if (vue.length === 0) return t('cmd.aucune-equipe-equipe-creer-nom')
        return vue
          .map((e) => {
            const noms = e.membres.map((id) => session.joueurs.get(id)?.nom ?? '?').join(', ')
            return t('cmd.pret-s', { v1: e.nom, v2: e.couleur, v3: noms || 'personne', v4: e.prets.length, v5: e.membres.length })
          })
          .join(' · ')
      }

      if (quoi === 'creer') {
        if (!nom) return t('cmd.donne-un-nom-equipe-creer')
        const e = session.equipes.creer(nom)
        if (!e) return t('cmd.impossible-trop-d-equipes-ou')
        session.equipes.mettre(joueur.id, e.id)
        session.messageATous(t('cmd.cree-l-equipe', { v1: joueur.nom, v2: e.nom }))
        return null
      }

      if (quoi === 'rejoindre') {
        const e = session.equipes.parNom(nom)
        if (!e) return t('cmd.aucune-equipe-de-ce-nom')
        session.equipes.mettre(joueur.id, e.id)
        session.messageATous(t('cmd.rejoint', { v1: joueur.nom, v2: e.nom }))
        return null
      }

      if (quoi === 'quitter') {
        const e = session.equipes.equipeDe(joueur.id)
        if (!e) return t('cmd.tu-n-es-dans-aucune')
        session.equipes.mettre(joueur.id, null)
        return t('cmd.tu-quittes', { v1: e.nom })
      }

      return t('cmd.au-choix-equipe-creer-rejoindre')
    },
  },

  pret: {
    aide: t('cmd.se-declarer-pret-ou-plus'),
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.equipes) return t('cmd.les-equipes-ne-sont-pas')
      const eq = session.equipes.equipeDe(joueur.id)
      if (!eq) return t('cmd.rejoins-une-equipe-d-abord')
      const valeur = (args[0] ?? '').toLowerCase() !== 'non'
      session.equipes.pret(joueur.id, valeur)
      if (valeur && session.equipes.tousPrets(eq.id)) {
        session.messageATous(t('cmd.toute-l-equipe-est-prete', { v1: eq.nom }))
        return null
      }
      /*
        ⚠️ DEUX PHRASES, PAS UNE PHRASE A TROU. « {nom} est prêt » et « {nom}
           n’est plus prêt » ne se construisent pas pareil dans toutes les
           langues : en coller un morceau au milieu marche en français et
           seulement en français.
      */
      session.messageATous(valeur ? 'cmd.equipier-pret' : 'cmd.equipier-plus-pret', {
        v1: joueur.nom,
        v2: eq.nom,
      })
      return null
    },
  },

  // ── Activites ───────────────────────────────────────────────────────────

  activite: {
    aide: t('cmd.objectifs-activite-activite-creer-titre'),
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.activites) return t('cmd.les-activites-ne-sont-pas')
      const quoi = (args[0] ?? '').toLowerCase()
      const reste = args.slice(1).join(' ')

      if (!quoi) {
        const vue = session.activites.instantane().activites
        if (vue.length === 0) return t('cmd.aucune-activite-activite-creer-reparer')
        return vue
          .map((a) => {
            const faites = a.etapes.filter((e) => e.faite).length
            return `n°${a.id} ${a.titre} [${a.etat}] ${faites}/${a.etapes.length}`
          })
          .join(' · ')
      }

      if (quoi === 'creer') {
        const bouts = reste.split('|').map((s) => s.trim()).filter(Boolean)
        if (bouts.length === 0) return t('cmd.donne-un-titre-activite-creer')
        const eq = session.equipes ? session.equipes.equipeDe(joueur.id) : null
        const a = session.activites.creer({
          titre: bouts[0],
          etapes: bouts.slice(1),
          parQui: joueur.nom,
          idEquipe: eq ? eq.id : null,
        })
        if (!a) return t('cmd.impossible-trop-d-activites-en')
        session.messageATous(t('cmd.propose-n-etape-s-activite', { v1: joueur.nom, v2: a.titre, v3: a.id, v4: a.etapes.length, v5: a.id }))
        return null
      }

      if (quoi === 'demarrer') {
        const a = session.activites.demarrer(Number.parseInt(reste, 10))
        if (!a) return t('cmd.aucune-activite-proposee-sous-ce')
        session.messageATous(t('cmd.commence', { v1: a.titre }))
        return null
      }

      if (quoi === 'fait' || quoi === 'cocher') {
        const [idTexte, numeroTexte] = reste.split(/\s+/)
        const a = session.activites.cocher(
          Number.parseInt(idTexte, 10),
          Number.parseInt(numeroTexte, 10),
          joueur.nom,
        )
        if (!a) return t('cmd.rien-a-cocher-verifie-le')
        const e = a.etapes.find((x) => x.n === Number.parseInt(numeroTexte, 10))
        session.messageATous(
          a.etat === 'reussie'
            ? t('cmd.est-terminee-bravo', { v1: a.titre })
            : t('cmd.a-fait', { v1: joueur.nom, v2: e ? e.libelle : '?', v3: a.titre }),
        )
        return null
      }

      if (quoi === 'finir' || quoi === 'abandonner') {
        const a = session.activites.finir(Number.parseInt(reste, 10), 'abandonnee')
        if (!a) return t('cmd.aucune-activite-sous-ce-numero')
        session.messageATous(t('cmd.est-abandonnee', { v1: a.titre }))
        return null
      }

      return t('cmd.au-choix-activite-creer-demarrer')
    },
  },

  // ── Coffre commun ───────────────────────────────────────────────────────

  coffre: {
    aide: t('cmd.aide.coffre'),
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.inventaires) return t('cmd.le-coffre-commun-n-est')
      if ((args[0] ?? '').toLowerCase() === 'journal') {
        const j = session.inventaires.journalRecent(10)
        if (j.length === 0) return t('cmd.aucun-mouvement-pour-l-instant')
        return j
          .map((m) =>
            t(m.quoi === 'depot' ? 'cmd.coffre-depot' : 'cmd.coffre-retrait', {
              v1: m.parQui,
              v2: m.nombre,
              v3: m.objet,
            }),
          )
          .join(' · ')
      }
      const c = session.inventaires.contenu()
      if (c.length === 0) return t('cmd.le-coffre-commun-est-vide')
      return c.slice(0, 20).map((o) => `${o.nom} ×${o.nombre}`).join(' · ')
    },
  },

  sac: {
    aide: t('cmd.ce-que-quelqu-un-porte'),
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.inventaires) return t('cmd.l-inventaire-n-est-pas')
      const cible = args.length ? trouverJoueur(session, args.join(' ')) : joueur
      if (!cible) return t('cmd.personne-de-ce-nom-ou')
      const m = session.inventaires.miroir(cible.id)
      if (!m || m.objets.length === 0) return t('cmd.n-a-rien-declare-son', { v1: cible.nom })
      return `${cible.nom} : ${m.objets.slice(0, 20).map((o) => `${o.nom} ×${o.nombre}`).join(' · ')}`
    },
  },

  // ── Monde, reserve a qui en a le droit ──────────────────────────────────

  effacer: {
    aide: t('cmd.retirer-un-repere-n'),
    droit: 'expulser',
    faire(session, joueur, args) {
      const id = Number.parseInt(args[0], 10)
      if (!Number.isInteger(id)) return t('cmd.donne-le-numero-du-repere')
      return session.monde.retirerRepere(id) ? t('cmd.repere-n-retire', { v1: id }) : t('cmd.aucun-repere-n', { v1: id })
    },
  },

  meteo: {
    aide: t('cmd.changer-la-meteo-nom'),
    droit: 'meteo',
    faire(session, joueur, args) {
      const v = session.monde.reglerMeteo(args.join(' '))
      if (!v) return t('cmd.donne-une-meteo-meteo-orage')
      session.messageATous(t('cmd.la-meteo-passe-a', { v1: v }))
      return null
    },
  },

  heure: {
    aide: t('cmd.changer-l-heure-h-min'),
    droit: 'heure',
    faire(session, joueur, args) {
      const r = session.monde.reglerHeure(Number.parseInt(args[0], 10), Number.parseInt(args[1], 10))
      if (!r) return t('cmd.donne-une-heure-entre-0')
      session.messageATous(t('cmd.il-est-maintenant-h', { v1: String(r.heure).padStart(2, '0'), v2: String(r.minute).padStart(2, '0') }))
      return null
    },
  },

  temps: {
    aide: t('cmd.la-cadence-du-cycle-jour'),
    droit: 'heure',
    faire(session, joueur, args) {
      if (!session.temps) return t('cmd.l-horloge-du-serveur-n')
      if (args.length === 0) {
        const h = session.temps.instantane()
        return t('cmd.jour-h-cadence-meteo', { v1: h.jour, v2: String(h.heure).padStart(2, '0'), v3: String(h.minute).padStart(2, '0'), v4: h.cadence || t('cmd.figee'), v5: h.meteo })
      }
      const n = Number.parseInt(args[0], 10)
      if (!Number.isFinite(n) || n < 0 || n > 240) return t('cmd.donne-un-nombre-entre-0')
      session.temps.cadence = n
      session.messageATous(n === 0 ? t('cmd.l-horloge-est-figee') : t('cmd.le-temps-avance-de-min', { v1: n }))
      return null
    },
  },

  motd: {
    aide: t('cmd.le-mot-du-jour-vide'),
    droit: 'monde.ecrire',
    faire(session, joueur, args) {
      const texte = args.join(' ')
      const r = session.monde.poserDonnee('motd', texte || null)
      if (!r) return t('cmd.impossible-d-enregistrer-le-mot')
      if (!texte) return t('cmd.mot-du-jour-efface')
      session.messageATous(t('cmd.mot-du-jour', { v1: texte }))
      return null
    },
  },

  // ── Moderation ──────────────────────────────────────────────────────────

  expulser: {
    aide: t('cmd.expulser-quelqu-un-nom-raison'),
    droit: 'expulser',
    faire(session, joueur, args) {
      if (args.length === 0) return t('cmd.donne-un-nom-expulser-alex')
      const cible = trouverJoueur(session, args[0])
      if (!cible) return t('cmd.personne-de-ce-nom-ou')
      if (cible.id === joueur.id) return t('cmd.tu-ne-peux-pas-t')
      if (session.permissions && !session.permissions.domine(joueur, cible)) {
        return t('cmd.tu-ne-peux-pas-agir')
      }
      const raison = args.slice(1).join(' ') || t('cmd.expulse-par-un-responsable')
      session.envoyerA(cible, { t: 'expulse', raison })
      session.retirer(cible, t('cmd.expulse'))
      /*
        ⚠️ ON DIT QUE L'EXPULSION NE TIENT PAS. Elle ne dure qu'une seconde : le
           joueur se reconnecte aussitot. Un hote qui croit avoir regle un
           probleme ne l'a pas regle, et il doit le savoir.
      */
      return t('cmd.a-ete-expulse-il-peut', { v1: cible.nom, v2: cible.nom })
    },
  },

  bannir: {
    aide: t('cmd.bannir-nom-duree-30m-2h'),
    droit: 'bannir',
    faire(session, joueur, args) {
      if (!session.moderation) return t('cmd.la-moderation-n-est-pas')
      if (args.length === 0) return t('cmd.donne-un-nom-bannir-alex')
      const cible = trouverJoueur(session, args[0])
      if (!cible) return t('cmd.personne-de-ce-nom-en')
      if (cible.id === joueur.id) return t('cmd.tu-ne-peux-pas-te')
      if (session.permissions && !session.permissions.domine(joueur, cible)) {
        return t('cmd.tu-ne-peux-pas-agir')
      }

      const dureeMs = lireDuree(args[1])
      const decale = dureeMs === null ? 1 : 2
      if (dureeMs === null && args[1]) return t('cmd.duree-illisible-exemples-30m-2h')
      const raison = args.slice(decale).join(' ')

      const s = session.moderation.poser(
        'bannir',
        { empreinte: cible.empreinte, adresse: cible.adresse, nom: cible.nom },
        { raison, par: joueur.nom, dureeMs: dureeMs || 0 },
      )
      if (!s) return t('cmd.impossible-ni-identite-ni-adresse')

      session.envoyerA(cible, { t: 'expulse', raison: t('cmd.banni-raison', { v1: raison || t('cmd.sans-raison-donnee') }) })
      session.retirer(cible, 'banni')
      const parQuoi = s.empreinte ? t('cmd.identite', { v1: s.empreinte }) : `adresse (${cible.adresse})`
      /*
        ⚠️ ON AVERTIT QUAND LE BANNISSEMENT PORTE SUR UNE ADRESSE. Elle change,
           et elle est partagee par tous les gens d'une meme maison : bannir une
           adresse bannit parfois quelqu'un qui n'a rien fait.
      */
      const avis = s.empreinte
        ? ''
        : t('cmd.attention-une-adresse-change-et')
      return t('cmd.banni-sur-son', { v1: cible.nom, v2: decrireDuree(dureeMs || 0), v3: parQuoi, v4: avis })
    },
  },

  debannir: {
    aide: t('cmd.aide.debannir'),
    droit: 'bannir',
    faire(session, joueur, args) {
      if (!session.moderation) return t('cmd.la-moderation-n-est-pas')
      if (args.length === 0) return t('cmd.donne-une-empreinte-une-adresse')
      const n = session.moderation.lever('bannir', args.join(' '))
      return n ? t('cmd.bannissement-s-leve-s', { v1: n }) : t('cmd.rien-ne-correspond')
    },
  },

  museler: {
    aide: t('cmd.empecher-quelqu-un-de-parler'),
    droit: 'museler',
    faire(session, joueur, args) {
      if (!session.moderation) return t('cmd.la-moderation-n-est-pas')
      if (args.length === 0) return t('cmd.donne-un-nom-museler-alex')
      const cible = trouverJoueur(session, args[0])
      if (!cible) return t('cmd.personne-de-ce-nom-ou')
      if (session.permissions && !session.permissions.domine(joueur, cible)) {
        return t('cmd.tu-ne-peux-pas-agir')
      }
      const dureeMs = lireDuree(args[1])
      if (dureeMs === null && args[1]) return t('cmd.duree-illisible-exemples-15m-2h')
      const s = session.moderation.poser(
        'museler',
        { empreinte: cible.empreinte, adresse: cible.adresse, nom: cible.nom },
        { raison: args.slice(2).join(' '), par: joueur.nom, dureeMs: dureeMs || 0 },
      )
      /*
        ⚠️ SANS IDENTITÉ ET DERRIÈRE UNE ADRESSE PARTAGÉE, IL N'Y A RIEN À ÉPINGLER
           QUI DURE — mais il y a quand même quelqu'un qui parle maintenant. On
           muselè la SESSION : ça marche tout de suite, ça ne touche personne
           d'autre, et ça ne survit pas à sa déconnexion. On le dit, parce qu'une
           sanction qu'on croit permanente et qui ne l'est pas est pire qu'un
           refus.
      */
      if (!s) {
        cible.muselJusqua = dureeMs > 0 ? Date.now() + dureeMs : Number.MAX_SAFE_INTEGER
        session.messageA(cible, t('cmd.tu-ne-peux-plus-parler', { v1: decrireDuree(dureeMs || 0) }))
        return (
          /*
            ⚠️ UNE PHRASE, UNE CLE. Decoupee en trois morceaux recolles, elle etait
               intraduisible : l'ordre des propositions change d'une langue a
               l'autre, et personne ne peut deviner ou se remet le point.
          */
          t('cmd.museler-session', { v1: cible.nom, v2: decrireDuree(dureeMs || 0) })
        )
      }
      session.messageA(cible, t('cmd.tu-ne-peux-plus-parler', { v1: decrireDuree(dureeMs || 0) }))
      return t('cmd.ne-peut-plus-parler-2', { v1: cible.nom, v2: decrireDuree(dureeMs || 0) })
    },
  },

  demuseler: {
    aide: t('cmd.aide.demuseler'),
    droit: 'museler',
    faire(session, joueur, args) {
      if (!session.moderation) return t('cmd.la-moderation-n-est-pas')
      if (args.length === 0) return t('cmd.donne-un-nom-ou-une')
      // On lève aussi un musellement de session, qui n'est inscrit nulle part.
      const vise = trouverJoueur(session, args.join(' '))
      if (vise && vise.muselJusqua) vise.muselJusqua = 0
      const n = session.moderation.lever('museler', args.join(' '))
      return n ? t('cmd.silence-s-leve-s', { v1: n }) : t('cmd.rien-ne-correspond')
    },
  },

  sanctions: {
    aide: t('cmd.aide.sanctions'),
    droit: 'museler',
    faire(session) {
      if (!session.moderation) return t('cmd.la-moderation-n-est-pas')
      const l = session.moderation.liste()
      if (l.length === 0) return t('cmd.aucune-sanction-en-vigueur')
      return l
        .slice(0, 15)
        .map((s) => t('cmd.texte-3', { v1: s.genre, v2: s.nom, v3: s.parQuoi, v4: s.reste, v5: s.raison ? ` : ${s.raison}` : '' }))
        .join(' · ')
    },
  },

  role: {
    aide: t('cmd.donner-un-role-nom-empreinte'),
    droit: 'role',
    faire(session, joueur, args) {
      if (!session.permissions || !session.identites) return t('cmd.les-roles-ne-sont-pas')
      if (args.length < 2) return t('cmd.exemple-role-alex-moderateur')

      const cible = trouverJoueur(session, args[0])
      const empreinte = cible ? cible.empreinte : args[0]
      if (!empreinte) return t('cmd.ce-joueur-n-a-pas')

      const demande = args[1].toLowerCase()
      const r = demande === 'aucun' || demande === 'rien' ? null : demande
      const erreur = session.permissions.poserRole(joueur, empreinte, r)
      if (erreur) return erreur
      if (cible) session.messageA(cible, r ? t('cmd.tu-es-maintenant', { v1: r }) : t('cmd.ton-role-a-ete-retire'))
      return r ? t('cmd.est-maintenant', { v1: cible ? cible.nom : empreinte, v2: r }) : t('cmd.role-retire')
    },
  },

  profil: {
    aide: t('cmd.le-profil-de-quelqu-un'),
    droit: 'joueurs.detail',
    faire(session, joueur, args) {
      if (!session.identites) return t('cmd.les-profils-ne-sont-pas')
      const cible = args.length ? trouverJoueur(session, args.join(' ')) : joueur
      if (!cible) return t('cmd.personne-de-ce-nom-ou')
      if (!cible.empreinte) return t('cmd.joue-en-anonyme-aucun-profil', { v1: cible.nom })
      const p = session.identites.profil(cible.empreinte)
      if (!p) return t('cmd.profil-introuvable')
      const noms = p.noms.length > 1 ? ` · pseudos : ${p.noms.join(', ')}` : ''
      return t('cmd.session-s-h-role', { v1: p.nom, v2: p.empreinte, v3: p.sessions, v4: Math.round(p.tempsDeJeuMs / 360_000) / 10, v5: p.role || 'joueur', v6: noms })
    },
  },

  // ── Spectateur ──────────────────────────────────────────────────────────

  spectateur: {
    aide: t('cmd.aide.spectateur'),
    droit: 'spectateur',
    faire(session, joueur) {
      if (joueur.spectateur) {
        if (session.nombreJouant >= session.config.maxJoueurs) return t('cmd.toutes-les-places-de-joueur')
        joueur.spectateur = false
        session.messageATous(t('cmd.revient-en-jeu', { v1: joueur.nom }))
        return null
      }
      /*
        ⚠️ UN HOTE NE PASSE PAS SPECTATEUR SANS PASSER LA MAIN. Il porte
           l'autorite sur les creatures et les droits de la partie : en
           spectateur, il n'y aurait plus personne pour decider.
      */
      if (joueur.hote && session.nombreJouant > 1) {
        return t('cmd.tu-es-l-hote-passe')
      }
      joueur.spectateur = true
      session.messageATous(t('cmd.passe-spectateur', { v1: joueur.nom }))
      return null
    },
  },

  // ── Diagnostic ──────────────────────────────────────────────────────────

  diag: {
    aide: t('cmd.l-etat-du-serveur-reseau'),
    droit: 'diagnostic',
    faire(session) {
      if (!session.mesures) return t('cmd.les-mesures-ne-sont-pas')
      const m = session.mesures.rapport()
      const r = m.reseau
      const ticks = m.ticks
      return [
        t('cmd.memoire-mo', { v1: m.memoireMo }),
        t('cmd.processeur', { v1: m.cpuPourcent === null ? 'N/A' : m.cpuPourcent + ' %' }),
        r ? t('cmd.reseau-ko-s', { v1: r.entrantKoParS, v2: r.sortantKoParS }) : t('cmd.reseau-n-a'),
        ticks ? t('cmd.tick', { v1: ticks.moyenneMs, v2: ticks.pireMs }) : t('cmd.tick-na'),
        t('cmd.instantane', { v1: m.instantaneOctets === null ? 'N/A' : m.instantaneOctets + ' o' }),
        t('cmd.entites', { v1: session.entites ? session.entites.nombre : 0 }),
        t('cmd.creatures', { v1: session.pnj ? session.pnj.nombre : 0 }),
      ].join(' · ')
    },
  },

  sonde: {
    aide: t('cmd.ce-que-le-mod-a'),
    droit: 'diagnostic',
    faire(session, joueur, args) {
      const cible = args.length ? trouverJoueur(session, args.join(' ')) : joueur
      if (!cible) return t('cmd.personne-de-ce-nom-ou')
      const f = cible.faits
      if (!f || Object.keys(f).length === 0) return t('cmd.n-a-encore-rien-signale', { v1: cible.nom })
      return `${cible.nom} : ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(' · ')}`
    },
  },

  pnj: {
    aide: t('cmd.les-creatures-que-l-hote'),
    droit: 'diagnostic',
    faire(session) {
      if (!session.pnj) return t('cmd.le-suivi-des-creatures-n')
      const l = session.pnj.toutes()
      if (l.length === 0) return t('cmd.aucune-creature-signalee-c-est')
      const parClasse = new Map()
      for (const c of l) parClasse.set(c.classe, (parClasse.get(c.classe) || 0) + 1)
      return [...parClasse.entries()].map(([c, n]) => `${c} ×${n}`).join(' · ')
    },
  },

  ressources: {
    aide: t('cmd.aide.ressources'),
    droit: 'ressource',
    faire(session, joueur, args) {
      if (!session.ressources) return t('cmd.le-systeme-de-ressources-n')
      if ((args[0] ?? '').toLowerCase() === 'recharger') {
        const r = session.ressources.rechargerTout()
        return t('cmd.ressource-s-rechargee-s', {
          v1: r.charges,
          v2: r.refuses ? t('cmd.dont-refusees', { v1: r.refuses }) : '',
        })
      }
      const l = session.ressources.liste()
      if (l.length === 0) return t('cmd.aucune-ressource-installee')
      return l.map((r) => `${r.nom} v${r.version} ${r.active ? 'active' : `ARRÊTÉE (${r.erreur})`}`).join(' · ')
    },
  },

  transport: {
    aide: t('cmd.aide.transport'),
    droit: 'diagnostic',
    faire() {
      const r = transport.rapport()
      const lignes = r.chemins.map((c) => `${c.nom} : ${c.etat}`)
      return t('cmd.retenu', { v1: r.nom, v2: lignes.join(' · ') })
    },
  },
}

/**
 * Execute une ligne de commande. Rend le texte a renvoyer au joueur, ou null
 * si la commande a deja parle d'elle-meme.
 */
function executer(session, joueur, ligne) {
  // C'est ici, et seulement ici, que la langue de la reponse est decidee.
  langueCourante = langueValide(joueur && joueur.langue)
  const sansBarre = ligne.startsWith('/') ? ligne.slice(1) : ligne
  const [nom, ...args] = sansBarre.split(/\s+/)
  const cle = nom.toLowerCase()
  const commande = COMMANDES[cle]

  if (session.mesures) session.mesures.commandes++

  if (!commande) {
    // Une ressource a peut-etre ajoute cette commande.
    if (session.ressources) {
      const ajoutee = session.ressources.commande(cle)
      if (ajoutee) {
        if (!session.peut(joueur, ajoutee.droit)) return t('cmd.tu-n-as-pas-le')
        try {
          const r = ajoutee.faire(session.vuePourRessource(joueur), args)
          return typeof r === 'string' ? r.slice(0, 240) : null
        } catch (e) {
          return t('cmd.la-commande-a-echoue', { v1: e instanceof Error ? e.message : 'erreur inconnue' })
        }
      }
    }
    return t('cmd.commande-inconnue-tape-aide', { v1: nom })
  }

  const droit = commande.droit || 'commande'
  if (!session.peut(joueur, droit)) {
    /*
      ⚠️ UN REFUS DIT A QUI C'EST RESERVE. « Tu n'as pas le droit » laisse le
         joueur deviner s'il doit demander, attendre, ou si le serveur est
         casse.
    */
    const requis = session.permissions ? session.permissions.plusBasRolePour(droit) : null
    const titres = { hote: t('cmd.l-hote'), moderateur: t('cmd.un-moderateur'), admin: t('cmd.un-administrateur'), proprietaire: t('cmd.le-proprietaire') }
    const qui = requis ? (titres[requis] ?? requis) : 'un responsable'
    return t('cmd.cette-commande-est-reservee-a', { v1: qui, v2: session.role(joueur) })
  }

  try {
    return commande.faire(session, joueur, args)
  } catch (e) {
    // Une commande qui plante ne doit pas emporter le serveur avec elle.
    return t('cmd.la-commande-a-echoue', { v1: e instanceof Error ? e.message : 'erreur inconnue' })
  }
}

module.exports = { executer, COMMANDES, distance, cap, trouverJoueur }
