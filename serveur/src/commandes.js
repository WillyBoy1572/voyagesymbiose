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
const CARDINAUX = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest']

function cap(de, vers) {
  const dx = vers.x - de.x
  const dy = vers.y - de.y
  // Dans Unreal, X va vers le nord et Y vers l'est.
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle < 0) angle += 360
  const index = Math.round(angle / 45) % 8
  return CARDINAUX[index]
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
    aide: 'la liste des commandes',
    droit: 'commande',
    faire(session, joueur, args) {
      const sujet = (args[0] ?? '').toLowerCase().replace(/^\//, '')
      if (sujet && COMMANDES[sujet]) {
        return `/${sujet} — ${COMMANDES[sujet].aide}`
      }
      const noms = Object.entries(COMMANDES)
        .filter(([, c]) => session.peut(joueur, c.droit || 'commande'))
        .map(([n]) => `/${n}`)
      if (session.ressources) {
        for (const c of session.ressources.toutesLesCommandes()) noms.push(`/${c.nom}`)
      }
      return `Commandes (${noms.length}) : ${noms.join('  ')} · /aide <commande> pour le détail`
    },
  },

  moi: {
    aide: 'ton identité, ton rôle, ton temps de jeu',
    droit: 'commande',
    faire(session, joueur) {
      const bouts = [`${joueur.nom} — rôle ${session.role(joueur)}`]
      bouts.push(joueur.empreinte ? `identité ${joueur.empreinte}` : 'anonyme (pas d’identité signée)')
      if (session.identites && joueur.empreinte) {
        const p = session.identites.publique(joueur.empreinte)
        if (p) bouts.push(`${p.sessions} session(s), ${p.heuresDeJeu} h de jeu`)
      }
      const eq = session.equipes ? session.equipes.equipeDe(joueur.id) : null
      if (eq) bouts.push(`équipe ${eq.nom}`)
      bouts.push(`${joueur.ping} ms`)
      return bouts.join(' · ')
    },
  },

  version: {
    aide: 'la version du serveur et son transport',
    droit: 'commande',
    faire(session) {
      const t = transport.choisir()
      return `${session.config.nom} — serveur v${session.config.version}, protocole ${session.config.protocole} (min ${session.config.protocoleMinimum}), transport ${t.nom}`
    },
  },

  joueurs: {
    aide: 'qui est connecté',
    droit: 'commande',
    faire(session) {
      const liste = [...session.joueurs.values()]
        .map((j) => {
          const marques = []
          if (j.hote) marques.push('hôte')
          if (j.spectateur) marques.push('spectateur')
          const r = session.role(j)
          if (r !== 'joueur' && r !== 'hote' && r !== 'spectateur') marques.push(r)
          return `${j.nom}${marques.length ? ` (${marques.join(', ')})` : ''} — ${j.ping} ms`
        })
        .join(' · ')
      return `${session.nombreJouant}/${session.config.maxJoueurs} : ${liste}`
    },
  },

  ou: {
    aide: 'ta position',
    droit: 'commande',
    faire(session, joueur) {
      const { x, y, z } = joueur.pos
      return `Tu es à ${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}.`
    },
  },

  pres: {
    aide: 'qui est autour de toi [mètres]',
    droit: 'commande',
    faire(session, joueur, args) {
      const rayon = Math.min(Math.max(Number.parseInt(args[0], 10) || 100, 1), 10_000)
      const autour = [...session.joueurs.values()]
        .filter((j) => j.id !== joueur.id)
        .map((j) => ({ j, d: distance(joueur.pos, j.pos) }))
        .filter((e) => e.d <= rayon * 100)
        .sort((a, b) => a.d - b.d)
      if (autour.length === 0) return `Personne à moins de ${rayon} m.`
      return autour.map((e) => `${e.j.nom} à ${(e.d / 100).toFixed(0)} m`).join(' · ')
    },
  },

  cap: {
    aide: 'la direction et la distance de chacun (radar en texte)',
    droit: 'commande',
    faire(session, joueur) {
      const autres = [...session.joueurs.values()]
        .filter((j) => j.id !== joueur.id && !j.spectateur)
        .map((j) => ({ j, d: distance(joueur.pos, j.pos), c: cap(joueur.pos, j.pos) }))
        .sort((a, b) => a.d - b.d)
      if (autres.length === 0) return 'Tu es seul en jeu.'
      return autres.map((e) => `${e.j.nom} — ${(e.d / 100).toFixed(0)} m, ${e.c}`).join(' · ')
    },
  },

  rdv: {
    aide: 'le point de rendez-vous (/rdv poser pour le fixer ici)',
    droit: 'rdv',
    faire(session, joueur, args) {
      const sv = session.sauvegardes
      if (!sv) return 'Le serveur ne retient rien pour l’instant.'

      if ((args[0] ?? '').toLowerCase() === 'poser') {
        const r = sv.poserRendezVous(joueur.nom, joueur.pos, joueur.rot)
        /*
          ⚠️ TOUT LE MONDE EST PREVENU TOUT DE SUITE. Un point pose en
             silence ne sert a personne : c'est justement quand quelqu'un
             arrive qu'il doit savoir ou aller.
        */
        session.diffuser({ t: 'rdv', rdv: r })
        session.messageATous(`${joueur.nom} a posé le point de rendez-vous.`)
        return null
      }

      if ((args[0] ?? '').toLowerCase() === 'oublier') {
        sv.oublierRendezVous()
        session.diffuser({ t: 'rdv', rdv: null })
        return 'Point de rendez-vous oublié.'
      }

      const r = sv.pointDeRendezVous()
      if (!r) return 'Aucun point de rendez-vous. Tape /rdv poser là où tu veux que les autres arrivent.'

      const d = distance(joueur.pos, r.pos) / 100
      return `Rendez-vous posé par ${r.parQui} — à ${d.toFixed(0)} m de toi, ${cap(joueur.pos, r.pos)}. En jeu, F5 t’y emmène.`
    },
  },

  marquer: {
    aide: 'poser un repère ici [nom]',
    droit: 'marquer',
    faire(session, joueur, args) {
      const r = session.monde.poserRepere(joueur.pos, args.join(' '), joueur.nom)
      if (!r) return 'Impossible : trop de repères sur ce serveur.'
      session.messageATous(`${joueur.nom} a posé le repère « ${r.libelle} » (n°${r.id}).`)
      return null
    },
  },

  reperes: {
    aide: 'la liste des repères',
    droit: 'commande',
    faire(session, joueur) {
      const liste = [...session.monde.reperes.values()]
      if (liste.length === 0) return 'Aucun repère pour l’instant. /marquer en pose un.'
      return liste
        .map((r) => `n°${r.id} ${r.libelle} — ${(distance(joueur.pos, r.pos) / 100).toFixed(0)} m, ${cap(joueur.pos, r.pos)}`)
        .slice(0, 20)
        .join(' · ')
    },
  },

  geste: {
    aide: `faire un geste (${GESTES.join(', ')})`,
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.evenements) return 'Les gestes ne sont pas disponibles sur ce serveur.'
      const quoi = (args[0] ?? '').toLowerCase()
      if (!GESTES.includes(quoi)) return `Au choix : ${GESTES.join(', ')}.`
      const e = session.evenements.preparer(joueur, { genre: 'geste', valeur: quoi })
      if (!e) return 'Doucement : trop de gestes d’un coup.'
      session.diffuserAutour(e)
      return null
    },
  },

  mp: {
    aide: 'message privé <nom> <texte>',
    droit: 'parler',
    faire(session, joueur, args) {
      if (args.length < 2) return 'Donne un nom et un message : /mp Alex on se retrouve au phare'
      const cible = trouverJoueur(session, args[0])
      if (!cible) return 'Personne de ce nom, ou plusieurs correspondent.'
      if (cible.id === joueur.id) return 'Tu te parles déjà tout seul.'
      const texte = args.slice(1).join(' ')
      session.envoyerA(cible, { t: 'chat', canal: 'prive', de: joueur.nom, id: joueur.id, texte })
      return `(privé à ${cible.nom}) ${texte}`
    },
  },

  // ── Equipes ─────────────────────────────────────────────────────────────

  equipe: {
    aide: 'équipes : /equipe, /equipe creer <nom>, /equipe rejoindre <nom>, /equipe quitter',
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.equipes) return 'Les équipes ne sont pas disponibles sur ce serveur.'
      const quoi = (args[0] ?? '').toLowerCase()
      const nom = args.slice(1).join(' ')

      if (!quoi) {
        const vue = session.equipes.instantane().equipes
        if (vue.length === 0) return 'Aucune équipe. /equipe creer <nom> en fait une.'
        return vue
          .map((e) => {
            const noms = e.membres.map((id) => session.joueurs.get(id)?.nom ?? '?').join(', ')
            return `${e.nom} (${e.couleur}) : ${noms || 'personne'} — ${e.prets.length}/${e.membres.length} prêt(s)`
          })
          .join(' · ')
      }

      if (quoi === 'creer') {
        if (!nom) return 'Donne un nom : /equipe creer Phare'
        const e = session.equipes.creer(nom)
        if (!e) return 'Impossible : trop d’équipes, ou nom vide.'
        session.equipes.mettre(joueur.id, e.id)
        session.messageATous(`${joueur.nom} crée l’équipe « ${e.nom} ».`)
        return null
      }

      if (quoi === 'rejoindre') {
        const e = session.equipes.parNom(nom)
        if (!e) return 'Aucune équipe de ce nom. /equipe pour la liste.'
        session.equipes.mettre(joueur.id, e.id)
        session.messageATous(`${joueur.nom} rejoint « ${e.nom} ».`)
        return null
      }

      if (quoi === 'quitter') {
        const e = session.equipes.equipeDe(joueur.id)
        if (!e) return 'Tu n’es dans aucune équipe.'
        session.equipes.mettre(joueur.id, null)
        return `Tu quittes « ${e.nom} ».`
      }

      return 'Au choix : /equipe · creer · rejoindre · quitter'
    },
  },

  pret: {
    aide: 'se déclarer prêt, ou plus prêt',
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.equipes) return 'Les équipes ne sont pas disponibles sur ce serveur.'
      const eq = session.equipes.equipeDe(joueur.id)
      if (!eq) return 'Rejoins une équipe d’abord : /equipe creer <nom>'
      const valeur = (args[0] ?? '').toLowerCase() !== 'non'
      session.equipes.pret(joueur.id, valeur)
      if (valeur && session.equipes.tousPrets(eq.id)) {
        session.messageATous(`Toute l’équipe « ${eq.nom} » est prête.`)
        return null
      }
      session.messageATous(`${joueur.nom} ${valeur ? 'est prêt' : 'n’est plus prêt'} (${eq.nom}).`)
      return null
    },
  },

  // ── Activites ───────────────────────────────────────────────────────────

  activite: {
    aide: 'objectifs : /activite, /activite creer <titre> | <étape> | <étape>, /activite demarrer <n°>, /activite fait <n°> <étape>',
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.activites) return 'Les activités ne sont pas disponibles sur ce serveur.'
      const quoi = (args[0] ?? '').toLowerCase()
      const reste = args.slice(1).join(' ')

      if (!quoi) {
        const vue = session.activites.instantane().activites
        if (vue.length === 0) return 'Aucune activité. /activite creer Réparer le générateur | Trouver la pièce | La poser'
        return vue
          .map((a) => {
            const faites = a.etapes.filter((e) => e.faite).length
            return `n°${a.id} ${a.titre} [${a.etat}] ${faites}/${a.etapes.length}`
          })
          .join(' · ')
      }

      if (quoi === 'creer') {
        const bouts = reste.split('|').map((s) => s.trim()).filter(Boolean)
        if (bouts.length === 0) return 'Donne un titre : /activite creer Réparer le générateur | Trouver la pièce'
        const eq = session.equipes ? session.equipes.equipeDe(joueur.id) : null
        const a = session.activites.creer({
          titre: bouts[0],
          etapes: bouts.slice(1),
          parQui: joueur.nom,
          idEquipe: eq ? eq.id : null,
        })
        if (!a) return 'Impossible : trop d’activités en cours.'
        session.messageATous(`${joueur.nom} propose « ${a.titre} » (n°${a.id}, ${a.etapes.length} étape(s)). /activite demarrer ${a.id}`)
        return null
      }

      if (quoi === 'demarrer') {
        const a = session.activites.demarrer(Number.parseInt(reste, 10))
        if (!a) return 'Aucune activité proposée sous ce numéro.'
        session.messageATous(`« ${a.titre} » commence.`)
        return null
      }

      if (quoi === 'fait' || quoi === 'cocher') {
        const [idTexte, numeroTexte] = reste.split(/\s+/)
        const a = session.activites.cocher(
          Number.parseInt(idTexte, 10),
          Number.parseInt(numeroTexte, 10),
          joueur.nom,
        )
        if (!a) return 'Rien à cocher : vérifie le numéro d’activité et celui de l’étape.'
        const e = a.etapes.find((x) => x.n === Number.parseInt(numeroTexte, 10))
        session.messageATous(
          a.etat === 'reussie'
            ? `« ${a.titre} » est terminée. Bravo.`
            : `${joueur.nom} a fait « ${e ? e.libelle : '?'} » (${a.titre}).`,
        )
        return null
      }

      if (quoi === 'finir' || quoi === 'abandonner') {
        const a = session.activites.finir(Number.parseInt(reste, 10), 'abandonnee')
        if (!a) return 'Aucune activité sous ce numéro.'
        session.messageATous(`« ${a.titre} » est abandonnée.`)
        return null
      }

      return 'Au choix : /activite · creer · demarrer · fait · finir'
    },
  },

  // ── Coffre commun ───────────────────────────────────────────────────────

  coffre: {
    aide: 'le coffre commun : /coffre, /coffre journal',
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.inventaires) return 'Le coffre commun n’est pas disponible sur ce serveur.'
      if ((args[0] ?? '').toLowerCase() === 'journal') {
        const j = session.inventaires.journalRecent(10)
        if (j.length === 0) return 'Aucun mouvement pour l’instant.'
        return j.map((m) => `${m.parQui} ${m.quoi === 'depot' ? 'a déposé' : 'a pris'} ${m.nombre} ${m.objet}`).join(' · ')
      }
      const c = session.inventaires.contenu()
      if (c.length === 0) return 'Le coffre commun est vide. En jeu, F10 y dépose ce que tu portes.'
      return c.slice(0, 20).map((o) => `${o.nom} ×${o.nombre}`).join(' · ')
    },
  },

  sac: {
    aide: 'ce que quelqu’un porte <nom>',
    droit: 'commande',
    faire(session, joueur, args) {
      if (!session.inventaires) return 'L’inventaire n’est pas disponible sur ce serveur.'
      const cible = args.length ? trouverJoueur(session, args.join(' ')) : joueur
      if (!cible) return 'Personne de ce nom, ou plusieurs correspondent.'
      const m = session.inventaires.miroir(cible.id)
      if (!m || m.objets.length === 0) return `${cible.nom} n’a rien déclaré (son mod ne lit pas encore l’inventaire).`
      return `${cible.nom} : ${m.objets.slice(0, 20).map((o) => `${o.nom} ×${o.nombre}`).join(' · ')}`
    },
  },

  // ── Monde, reserve a qui en a le droit ──────────────────────────────────

  effacer: {
    aide: 'retirer un repère <n°>',
    droit: 'expulser',
    faire(session, joueur, args) {
      const id = Number.parseInt(args[0], 10)
      if (!Number.isInteger(id)) return 'Donne le numéro du repère : /effacer 3'
      return session.monde.retirerRepere(id) ? `Repère n°${id} retiré.` : `Aucun repère n°${id}.`
    },
  },

  meteo: {
    aide: 'changer la météo <nom>',
    droit: 'meteo',
    faire(session, joueur, args) {
      const v = session.monde.reglerMeteo(args.join(' '))
      if (!v) return 'Donne une météo : /meteo orage'
      session.messageATous(`La météo passe à « ${v} ».`)
      return null
    },
  },

  heure: {
    aide: 'changer l’heure <h> [min]',
    droit: 'heure',
    faire(session, joueur, args) {
      const r = session.monde.reglerHeure(Number.parseInt(args[0], 10), Number.parseInt(args[1], 10))
      if (!r) return 'Donne une heure entre 0 et 23 : /heure 21'
      session.messageATous(`Il est maintenant ${String(r.heure).padStart(2, '0')} h ${String(r.minute).padStart(2, '0')}.`)
      return null
    },
  },

  temps: {
    aide: 'la cadence du cycle jour/nuit [minutes de jeu par minute réelle]',
    droit: 'heure',
    faire(session, joueur, args) {
      if (!session.temps) return 'L’horloge du serveur n’est pas disponible.'
      if (args.length === 0) {
        const t = session.temps.instantane()
        return `Jour ${t.jour}, ${String(t.heure).padStart(2, '0')} h ${String(t.minute).padStart(2, '0')} — cadence ${t.cadence || 'figée'}, météo ${t.meteo}.`
      }
      const n = Number.parseInt(args[0], 10)
      if (!Number.isFinite(n) || n < 0 || n > 240) return 'Donne un nombre entre 0 (figée) et 240.'
      session.temps.cadence = n
      session.messageATous(n === 0 ? 'L’horloge est figée.' : `Le temps avance de ${n} min de jeu par minute réelle.`)
      return null
    },
  },

  motd: {
    aide: 'le mot du jour (vide pour l’effacer)',
    droit: 'monde.ecrire',
    faire(session, joueur, args) {
      const texte = args.join(' ')
      const r = session.monde.poserDonnee('motd', texte || null)
      if (!r) return 'Impossible d’enregistrer le mot du jour.'
      if (!texte) return 'Mot du jour effacé.'
      session.messageATous(`Mot du jour : ${texte}`)
      return null
    },
  },

  // ── Moderation ──────────────────────────────────────────────────────────

  expulser: {
    aide: 'expulser quelqu’un <nom> [raison]',
    droit: 'expulser',
    faire(session, joueur, args) {
      if (args.length === 0) return 'Donne un nom : /expulser Alex'
      const cible = trouverJoueur(session, args[0])
      if (!cible) return 'Personne de ce nom, ou plusieurs correspondent.'
      if (cible.id === joueur.id) return 'Tu ne peux pas t’expulser toi-même.'
      if (session.permissions && !session.permissions.domine(joueur, cible)) {
        return 'Tu ne peux pas agir sur quelqu’un d’un rang égal ou supérieur.'
      }
      const raison = args.slice(1).join(' ') || 'expulsé par un responsable'
      session.envoyerA(cible, { t: 'expulse', raison })
      session.retirer(cible, 'expulsé')
      /*
        ⚠️ ON DIT QUE L'EXPULSION NE TIENT PAS. Elle ne dure qu'une seconde : le
           joueur se reconnecte aussitot. Un hote qui croit avoir regle un
           probleme ne l'a pas regle, et il doit le savoir.
      */
      return `${cible.nom} a été expulsé. Il peut revenir tout de suite — /bannir ${cible.nom} 1h pour que ça tienne.`
    },
  },

  bannir: {
    aide: 'bannir <nom> [durée: 30m 2h 7j, vide = définitif] [raison]',
    droit: 'bannir',
    faire(session, joueur, args) {
      if (!session.moderation) return 'La modération n’est pas disponible sur ce serveur.'
      if (args.length === 0) return 'Donne un nom : /bannir Alex 2h insultes'
      const cible = trouverJoueur(session, args[0])
      if (!cible) return 'Personne de ce nom en jeu. Pour bannir un absent, donne son empreinte à /bannir-id.'
      if (cible.id === joueur.id) return 'Tu ne peux pas te bannir toi-même.'
      if (session.permissions && !session.permissions.domine(joueur, cible)) {
        return 'Tu ne peux pas agir sur quelqu’un d’un rang égal ou supérieur.'
      }

      const dureeMs = lireDuree(args[1])
      const decale = dureeMs === null ? 1 : 2
      if (dureeMs === null && args[1]) return 'Durée illisible. Exemples : 30m, 2h, 7j, ou rien pour définitif.'
      const raison = args.slice(decale).join(' ')

      const s = session.moderation.poser(
        'bannir',
        { empreinte: cible.empreinte, adresse: cible.adresse, nom: cible.nom },
        { raison, par: joueur.nom, dureeMs: dureeMs || 0 },
      )
      if (!s) return 'Impossible : ni identité ni adresse à viser.'

      session.envoyerA(cible, { t: 'expulse', raison: `banni : ${raison || 'sans raison donnée'}` })
      session.retirer(cible, 'banni')
      const parQuoi = s.empreinte ? `identité ${s.empreinte}` : `adresse (${cible.adresse})`
      /*
        ⚠️ ON AVERTIT QUAND LE BANNISSEMENT PORTE SUR UNE ADRESSE. Elle change,
           et elle est partagee par tous les gens d'une meme maison : bannir une
           adresse bannit parfois quelqu'un qui n'a rien fait.
      */
      const avis = s.empreinte
        ? ''
        : ' — attention : une adresse change et peut être partagée par plusieurs personnes'
      return `${cible.nom} banni ${decrireDuree(dureeMs || 0)} sur son ${parQuoi}${avis}.`
    },
  },

  debannir: {
    aide: 'lever un bannissement <empreinte|adresse|nom>',
    droit: 'bannir',
    faire(session, joueur, args) {
      if (!session.moderation) return 'La modération n’est pas disponible sur ce serveur.'
      if (args.length === 0) return 'Donne une empreinte, une adresse ou un nom : /debannir a1b2c3…'
      const n = session.moderation.lever('bannir', args.join(' '))
      return n ? `${n} bannissement(s) levé(s).` : 'Rien ne correspond.'
    },
  },

  museler: {
    aide: 'empêcher quelqu’un de parler <nom> [durée]',
    droit: 'museler',
    faire(session, joueur, args) {
      if (!session.moderation) return 'La modération n’est pas disponible sur ce serveur.'
      if (args.length === 0) return 'Donne un nom : /museler Alex 15m'
      const cible = trouverJoueur(session, args[0])
      if (!cible) return 'Personne de ce nom, ou plusieurs correspondent.'
      if (session.permissions && !session.permissions.domine(joueur, cible)) {
        return 'Tu ne peux pas agir sur quelqu’un d’un rang égal ou supérieur.'
      }
      const dureeMs = lireDuree(args[1])
      if (dureeMs === null && args[1]) return 'Durée illisible. Exemples : 15m, 2h.'
      const s = session.moderation.poser(
        'museler',
        { empreinte: cible.empreinte, adresse: cible.adresse, nom: cible.nom },
        { raison: args.slice(2).join(' '), par: joueur.nom, dureeMs: dureeMs || 0 },
      )
      if (!s) return 'Impossible : ni identité ni adresse à viser.'
      session.messageA(cible, `Tu ne peux plus parler (${decrireDuree(dureeMs || 0)}).`)
      return `${cible.nom} ne peut plus parler — ${decrireDuree(dureeMs || 0)}.`
    },
  },

  demuseler: {
    aide: 'rendre la parole <empreinte|adresse|nom>',
    droit: 'museler',
    faire(session, joueur, args) {
      if (!session.moderation) return 'La modération n’est pas disponible sur ce serveur.'
      if (args.length === 0) return 'Donne un nom ou une empreinte.'
      const n = session.moderation.lever('museler', args.join(' '))
      return n ? `${n} silence(s) levé(s).` : 'Rien ne correspond.'
    },
  },

  sanctions: {
    aide: 'la liste des bannissements et des silences',
    droit: 'museler',
    faire(session) {
      if (!session.moderation) return 'La modération n’est pas disponible sur ce serveur.'
      const l = session.moderation.liste()
      if (l.length === 0) return 'Aucune sanction en vigueur.'
      return l
        .slice(0, 15)
        .map((s) => `${s.genre} ${s.nom} (${s.parQuoi}) — ${s.reste}${s.raison ? ` : ${s.raison}` : ''}`)
        .join(' · ')
    },
  },

  role: {
    aide: 'donner un rôle <nom|empreinte> <proprietaire|admin|moderateur|joueur|aucun>',
    droit: 'role',
    faire(session, joueur, args) {
      if (!session.permissions || !session.identites) return 'Les rôles ne sont pas disponibles sur ce serveur.'
      if (args.length < 2) return 'Exemple : /role Alex moderateur'

      const cible = trouverJoueur(session, args[0])
      const empreinte = cible ? cible.empreinte : args[0]
      if (!empreinte) return 'Ce joueur n’a pas d’identité signée : impossible de lui donner un rôle durable.'

      const demande = args[1].toLowerCase()
      const r = demande === 'aucun' || demande === 'rien' ? null : demande
      const erreur = session.permissions.poserRole(joueur, empreinte, r)
      if (erreur) return erreur
      if (cible) session.messageA(cible, r ? `Tu es maintenant ${r}.` : 'Ton rôle a été retiré.')
      return r ? `${cible ? cible.nom : empreinte} est maintenant ${r}.` : 'Rôle retiré.'
    },
  },

  profil: {
    aide: 'le profil de quelqu’un <nom>',
    droit: 'joueurs.detail',
    faire(session, joueur, args) {
      if (!session.identites) return 'Les profils ne sont pas disponibles sur ce serveur.'
      const cible = args.length ? trouverJoueur(session, args.join(' ')) : joueur
      if (!cible) return 'Personne de ce nom, ou plusieurs correspondent.'
      if (!cible.empreinte) return `${cible.nom} joue en anonyme : aucun profil durable.`
      const p = session.identites.profil(cible.empreinte)
      if (!p) return 'Profil introuvable.'
      const noms = p.noms.length > 1 ? ` · pseudos : ${p.noms.join(', ')}` : ''
      return `${p.nom} [${p.empreinte}] — ${p.sessions} session(s), ${Math.round(p.tempsDeJeuMs / 360_000) / 10} h, rôle ${p.role || 'joueur'}${noms}`
    },
  },

  // ── Spectateur ──────────────────────────────────────────────────────────

  spectateur: {
    aide: 'passer spectateur, ou revenir en jeu',
    droit: 'spectateur',
    faire(session, joueur) {
      if (joueur.spectateur) {
        if (session.nombreJouant >= session.config.maxJoueurs) return 'Toutes les places de joueur sont prises.'
        joueur.spectateur = false
        session.messageATous(`${joueur.nom} revient en jeu.`)
        return null
      }
      /*
        ⚠️ UN HOTE NE PASSE PAS SPECTATEUR SANS PASSER LA MAIN. Il porte
           l'autorite sur les creatures et les droits de la partie : en
           spectateur, il n'y aurait plus personne pour decider.
      */
      if (joueur.hote && session.nombreJouant > 1) {
        return 'Tu es l’hôte : passe la main avant (quitte et reviens, ou attends qu’un autre joue).'
      }
      joueur.spectateur = true
      session.messageATous(`${joueur.nom} passe spectateur.`)
      return null
    },
  },

  // ── Diagnostic ──────────────────────────────────────────────────────────

  diag: {
    aide: 'l’état du serveur : réseau, ticks, mémoire',
    droit: 'diagnostic',
    faire(session) {
      if (!session.mesures) return 'Les mesures ne sont pas disponibles sur ce serveur.'
      const m = session.mesures.rapport()
      const r = m.reseau
      const t = m.ticks
      return [
        `mémoire ${m.memoireMo} Mo`,
        `processeur ${m.cpuPourcent === null ? 'N/A' : m.cpuPourcent + ' %'}`,
        r ? `réseau ${r.entrantKoParS} ↓ / ${r.sortantKoParS} ↑ ko/s` : 'réseau N/A',
        t ? `tick ${t.moyenneMs} ms (pire ${t.pireMs})` : 'tick N/A',
        `instantané ${m.instantaneOctets === null ? 'N/A' : m.instantaneOctets + ' o'}`,
        `entités ${session.entites ? session.entites.nombre : 0}`,
        `créatures ${session.pnj ? session.pnj.nombre : 0}`,
      ].join(' · ')
    },
  },

  sonde: {
    aide: 'ce que le mod a réussi à faire dans le jeu <nom>',
    droit: 'diagnostic',
    faire(session, joueur, args) {
      const cible = args.length ? trouverJoueur(session, args.join(' ')) : joueur
      if (!cible) return 'Personne de ce nom, ou plusieurs correspondent.'
      const f = cible.faits
      if (!f || Object.keys(f).length === 0) return `${cible.nom} n’a encore rien signalé.`
      return `${cible.nom} : ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(' · ')}`
    },
  },

  pnj: {
    aide: 'les créatures que l’hôte voit',
    droit: 'diagnostic',
    faire(session) {
      if (!session.pnj) return 'Le suivi des créatures n’est pas disponible.'
      const l = session.pnj.toutes()
      if (l.length === 0) return 'Aucune créature signalée. C’est l’hôte qui les rapporte.'
      const parClasse = new Map()
      for (const c of l) parClasse.set(c.classe, (parClasse.get(c.classe) || 0) + 1)
      return [...parClasse.entries()].map(([c, n]) => `${c} ×${n}`).join(' · ')
    },
  },

  ressources: {
    aide: 'les ressources du serveur : /ressources, /ressources recharger',
    droit: 'ressource',
    faire(session, joueur, args) {
      if (!session.ressources) return 'Le système de ressources n’est pas disponible.'
      if ((args[0] ?? '').toLowerCase() === 'recharger') {
        const r = session.ressources.rechargerTout()
        return `${r.charges} ressource(s) rechargée(s)${r.refuses ? `, ${r.refuses} refusée(s)` : ''}.`
      }
      const l = session.ressources.liste()
      if (l.length === 0) return 'Aucune ressource installée.'
      return l.map((r) => `${r.nom} v${r.version} ${r.active ? 'active' : `ARRÊTÉE (${r.erreur})`}`).join(' · ')
    },
  },

  transport: {
    aide: 'par quel chemin passent les paquets, et pourquoi pas les autres',
    droit: 'diagnostic',
    faire() {
      const r = transport.rapport()
      const lignes = r.chemins.map((c) => `${c.nom} : ${c.etat}`)
      return `Retenu : ${r.nom}. ${lignes.join(' · ')}`
    },
  },
}

/**
 * Execute une ligne de commande. Rend le texte a renvoyer au joueur, ou null
 * si la commande a deja parle d'elle-meme.
 */
function executer(session, joueur, ligne) {
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
        if (!session.peut(joueur, ajoutee.droit)) return 'Tu n’as pas le droit de faire ça.'
        try {
          const r = ajoutee.faire(session.vuePourRessource(joueur), args)
          return typeof r === 'string' ? r.slice(0, 240) : null
        } catch (e) {
          return `La commande a échoué : ${e instanceof Error ? e.message : 'erreur inconnue'}`
        }
      }
    }
    return `Commande inconnue : /${nom}. Tape /aide.`
  }

  const droit = commande.droit || 'commande'
  if (!session.peut(joueur, droit)) {
    /*
      ⚠️ UN REFUS DIT A QUI C'EST RESERVE. « Tu n'as pas le droit » laisse le
         joueur deviner s'il doit demander, attendre, ou si le serveur est
         casse.
    */
    const requis = session.permissions ? session.permissions.plusBasRolePour(droit) : null
    const titres = { hote: 'l’hôte', moderateur: 'un modérateur', admin: 'un administrateur', proprietaire: 'le propriétaire' }
    const qui = requis ? (titres[requis] ?? requis) : 'un responsable'
    return `Cette commande est réservée à ${qui} (tu es ${session.role(joueur)}).`
  }

  try {
    return commande.faire(session, joueur, args)
  } catch (e) {
    // Une commande qui plante ne doit pas emporter le serveur avec elle.
    return `La commande a échoué : ${e instanceof Error ? e.message : 'erreur inconnue'}`
  }
}

module.exports = { executer, COMMANDES, distance, cap, trouverJoueur, CARDINAUX }
