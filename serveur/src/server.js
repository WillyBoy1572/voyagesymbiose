'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SYMBIOSE VOYAGE — serveur cooperatif pour The Last Caretaker
 * ═══════════════════════════════════════════════════════════════════════════
 *      node src/server.js
 *
 *  Jeu en UDP, monde et navigateur en TCP. Aucune dependance : uniquement la
 *  bibliotheque standard de Node. Le serveur demarre donc sans `npm install`,
 *  ce qui compte quand il tourne dans un conteneur d'hebergement.
 *
 *  ⚠️ LE SERVEUR FAIT AUTORITE. Un client annonce SA position, rien d'autre.
 *     Tout le reste — meteo, heure, reperes, roles, coffre, qui est hote — est
 *     decide ici.
 *
 *  ⚠️ IL NE MEURT PAS SUR UNE ERREUR DE CLIENT. Un paquet malforme, un
 *     plantage de commande, un client qui disparait : on journalise et on
 *     continue. Quatre amis ne doivent pas perdre leur partie parce qu'un
 *     paquet etait bizarre.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const dgram = require('node:dgram')
const config = require('./config')
const journal = require('./journal')
const { decoder, valider, encoder } = require('./protocole')
const { Monde } = require('./monde')
const { Entites } = require('./entites')
const { Identites } = require('./identite')
const { Permissions } = require('./permissions')
const { Moderation } = require('./moderation')
const { Equipes } = require('./equipes')
const { Activites } = require('./activites')
const { Inventaires } = require('./inventaire')
const { Pnj } = require('./pnj')
const { Evenements } = require('./evenements')
const { Temps } = require('./temps')
const { Mesures } = require('./mesures')
const { Ressources } = require('./ressources')
const { Annuaire } = require('./annuaire')
const { RendezVous } = require('./rendezvous')
const { Percage } = require('./percage')
const { Session } = require('./session')
const { executer } = require('./commandes')
const { creerHttp } = require('./http')
const { Sauvegardes } = require('./sauvegardes')
const transport = require('./transport')

const dire = (t) => journal.info(t)

const monde = new Monde()
const entites = new Entites(config, dire)
const identites = new Identites(config, dire)
const permissions = new Permissions(config, identites)
/*
  ⚠️ LA MODERATION A BESOIN DE SAVOIR SI UNE ADRESSE EST PARTAGEE, et seule
     la session le sait. On lui passe la question, pas la table : elle n'a
     aucune raison de pouvoir lire les joueurs.
*/
const moderation = new Moderation(config, dire, (adresse) => {
  if (!adresse) return false
  let vus = 0
  for (const j of session.joueurs.values()) {
    if (j.adresse === adresse && ++vus > 1) return true
  }
  return false
})
const equipes = new Equipes()
const activites = new Activites(dire)
const inventaires = new Inventaires(config, dire)
const pnj = new Pnj(dire)
const evenements = new Evenements(dire)
const mesures = new Mesures()
const sauvegardes = new Sauvegardes(config, dire)
const temps = new Temps(config, monde, (t) => session.annoncer(t))

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

/** Envoi direct, hors session : sert au rendez-vous et au percage. */
function envoyerBrut(objet, port, adresse) {
  const tampon = encoder(objet)
  mesures.envoye(tampon.length)
  socket.send(tampon, port, adresse, () => {})
}

/*
  ⚠️ LE RENDEZ-VOUS ET LE PERCAGE PARTAGENT LA PRISE UDP DU JEU, ET C'EST TOUT
     LE PRINCIPE. La box associe le port interne du JEU a un port public : c'est
     cette association-la qu'il faut garder ouverte. Faite depuis une seconde
     prise, elle ouvrirait un trou vers un port qui ne sert a rien.
*/
const rendezvous = new RendezVous(config, envoyerBrut, dire)
const percage = new Percage(config, envoyerBrut, dire)

/**
 * Envoie un paquet deja encode.
 *
 * ⚠️ C'EST LE SEUL ENDROIT QUI SAIT QUE LE RELAIS EXISTE. Tout le reste du
 *    serveur envoie a une adresse et un port ; si cette adresse est celle du
 *    relais, le paquet part dans une enveloppe vers le rendez-vous au lieu
 *    d'aller directement au joueur. Rien d'autre ne change -- et il ne faut pas
 *    qu'autre chose le sache, sinon il y aurait deux facons d'envoyer et une
 *    des deux oublierait le relais.
 */
function envoyerPaquet(tampon, port, adresse) {
  if (adresse === ADRESSE_RELAIS) {
    const rdv = percage.cible
    if (!rdv) return
    const enveloppe = encoder({ t: 'rdv-pont', s: port, d: tampon.toString('base64') })
    socket.send(enveloppe, rdv.port, rdv.adresse, (e) => {
      if (e) journal.avis(`relais ${port} — ${e.message}`)
    })
    return
  }
  socket.send(tampon, port, adresse, (e) => {
    // Un envoi rate vers un client parti n'est pas une erreur du serveur.
    if (e) journal.avis(`envoi vers ${adresse}:${port} — ${e.message}`)
  })
}

const session = new Session(
  config,
  monde,
  envoyerPaquet,
  {
    entites,
    identites,
    permissions,
    moderation,
    equipes,
    activites,
    inventaires,
    pnj,
    evenements,
    temps,
    mesures,
    sauvegardes,
  },
)

/*
  ⚠️ LES RESSOURCES SONT CREEES APRES LA SESSION, ET POSEES SUR ELLE ENSUITE.
     Elles ont besoin de la session pour annoncer et lister les joueurs, et la
     session a besoin d'elles pour emettre ses evenements : la dependance est
     circulaire, et c'est le seul ordre qui la casse proprement.
*/
const ressources = new Ressources(
  config,
  {
    annoncer: (t) => session.annoncer(t),
    messageA: (id, t) => {
      const j = session.joueurs.get(id)
      if (j) session.messageA(j, t)
    },
    joueurs: () => [...session.joueurs.values()].map((j) => session.vuePourRessource(j)),
    joueur: (id) => {
      const j = session.joueurs.get(id)
      return j ? session.vuePourRessource(j) : null
    },
    monde,
    entites,
    inventaires,
    activites,
  },
  dire,
)
session.ressources = ressources

const annuaire = new Annuaire(
  config,
  () => ({
    ...session.etat(),
    monde: sauvegardes.infoMonde().present ? sauvegardes.infoMonde().nom : null,
    transport: transport.choisir().retenu,
  }),
  dire,
)

/*
  ⚠️ LES SECRETS QUITTENT `process.env` UNE FOIS LUS. La configuration est
     figée au démarrage : plus personne n'a besoin d'y revenir. En revanche
     une ressource ajoutée dans `ressources/` y accède en une ligne (voir
     l'avertissement en tête de `ressources.js` : `node:vm` n'est pas un bac à
     sable). Les effacer ne rend pas l'isolation vraie — ça retire le butin.

     ⚠️ ON N'EFFACE PAS CE QUI SERT ENCORE. `DONNEES`, `PORT` et le reste
        sont relus nulle part, mais on ne touche qu'à ce qui est un secret.
*/
for (const nom of ['ADMIN_CLE', 'SERVER_PASSWORD', 'MONDE_MOTDEPASSE', 'ANNUAIRE_CLE']) {
  if (process.env[nom] !== undefined) delete process.env[nom]
}

// ── Reception ───────────────────────────────────────────────────────────────

socket.on('message', (tampon, info) => {
  mesures.recu(tampon.length)
  try {
    traiter(tampon, info.address, info.port)
  } catch (e) {
    journal.erreur(`paquet de ${info.address} : ${e instanceof Error ? e.message : e}`)
  }
})

/*
  ⚠️ LA SEULE VOIE NON AUTHENTIFIEE EST AUSSI LA PLUS CHERE. Un `bonjour`
     declenche une verification de signature ed25519 ; un `rdv-` fait repondre.
     Les deux arrivent sans jeton, depuis une adresse qu'on ne peut pas croire.
     Sans plafond, quelques milliers de paquets par seconde occupent le serveur
     a verifier des signatures inventees pendant que la partie s'arrete.

     Le plafond est par adresse et large : un joueur honnete envoie UN bonjour.
*/
/**
 * L'adresse d'un joueur qui passe par le relais.
 *
 * ⚠️ ON LUI DONNE UNE ADRESSE ET UN PORT COMME A TOUT LE MONDE. Le port est
 *    l'identifiant de session du relais : le couple est unique et stable, donc
 *    les jetons lies a l'adresse, les sessions, les expulsions et le reste du
 *    serveur continuent de marcher sans rien savoir du relais. Un seul endroit
 *    emballe, un seul deballe.
 */
const ADRESSE_RELAIS = '@relais'

const PAQUETS_LIBRES_PAR_SECONDE = 10
const compteursLibres = new Map()

function tropDeLibres(adresse) {
  const maintenant = Date.now()
  let c = compteursLibres.get(adresse)
  if (!c || maintenant - c.debut >= 1000) {
    c = { debut: maintenant, n: 0 }
    compteursLibres.set(adresse, c)
  }
  c.n++
  return c.n > PAQUETS_LIBRES_PAR_SECONDE
}

/* Sans ce menage, la table grossit d'une entree par adresse vue, pour toujours. */
setInterval(() => {
  const limite = Date.now() - 5000
  for (const [a, c] of compteursLibres) if (c.debut < limite) compteursLibres.delete(a)
}, 10_000).unref?.()

function traiter(tampon, adresse, port) {
  const brut = decoder(tampon)
  if (!brut) return mesures.refuse()

  const sansJeton =
    (typeof brut.t === 'string' && brut.t.startsWith('rdv-')) ||
    brut.t === 'bonjour' ||
    brut.t === 'sonde'
  /*
    ⚠️ LES JOUEURS RELAYES PARTAGENT UNE ADRESSE. Les compter ensemble ferait
       du plafond une punition collective : le deuxieme arrive mangerait le
       budget du premier. On compte par session de relais.
  */
  const cleLimite = adresse === ADRESSE_RELAIS ? `${ADRESSE_RELAIS}:${port}` : adresse
  if (sansJeton && tropDeLibres(cleLimite)) return mesures.refuse()

  /*
    ⚠️ LES MESSAGES DE RENDEZ-VOUS PASSENT AVANT LA SESSION, PAR DEFINITION. Ils
       servent a se trouver AVANT d'avoir la moindre session : leur demander un
       jeton n'aurait aucun sens. En echange ils ne lisent aucun etat de partie,
       ne modifient rien, et ne lisent aucun etat de partie.

       ⚠️ CE N'EST PAS « AUCUNE AMPLIFICATION », et l'ecrire serait faux :
          `rdv-joindre` fait envoyer un `rdv-perce` A L'HOTE, donc a un tiers.
          Un paquet pour un paquet, et seulement vers une adresse qui s'est
          elle-meme annoncee ici -- mais ce n'est pas zero, et le plafond
          par source ci-dessous est ce qui le borne.
  */
  /*
    ⚠️ UNE ENVELOPPE DE RELAIS SE DEBALLE UNE FOIS, ET PAS DEUX. Sans ce garde,
       une enveloppe qui en contient une autre nous ferait tourner en rond --
       et le `s` de la seconde pourrait viser un autre joueur que la premiere.
  */
  /*
    ⚠️ LA CONDITION PORTE SUR L'EXPEDITEUR, PAS SUR LE TYPE. Un serveur peut
       etre les DEUX : il tient un point de rendez-vous pour les autres ET il
       passe lui-meme par un relais. Intercepter tout `rdv-pont` ici empechait
       le point de rendez-vous de faire suivre les enveloppes des autres -- le
       relais s'ouvrait et aucun octet ne traversait.
  */
  if (brut.t === 'rdv-pont' && adresse !== ADRESSE_RELAIS && percage.estLeRendezVous(adresse, port)) {
    if (!Number.isInteger(brut.s) || typeof brut.d !== 'string') return mesures.refuse()
    let dedans
    try {
      dedans = decoder(Buffer.from(brut.d, 'base64'))
    } catch {
      return mesures.refuse()
    }
    if (!dedans || dedans.t === 'rdv-pont') return mesures.refuse()
    return traiterMessage(dedans, ADRESSE_RELAIS, brut.s)
  }

  /*
    ⚠️ UNE SONDE DIT LA LATENCE REELLE, PAS CELLE D'UNE PAGE WEB. La liste des
       serveurs se construit sur des appels HTTP ; or le jeu passe en UDP, sur
       un autre port, souvent par un autre chemin. Un serveur qui repond vite en
       TCP peut tres bien etre injouable.

    ⚠️ ELLE NE DIT RIEN D'AUTRE, ET RENVOIE EXACTEMENT CE QU'ELLE A RECU. Pas de
       nom, pas de nombre de joueurs, pas d'etat : une reponse plus grosse que
       la demande ferait de chaque serveur un amplificateur pour qui veut
       inonder quelqu'un en usurpant son adresse. Ici, un paquet pour un paquet,
       et le plafond par adresse ci-dessus borne le reste.
  */
  if (brut.t === 'sonde') {
    const ts = Number.isFinite(brut.ts) ? brut.ts : 0
    envoyerPaquet(encoder({ t: 'sonde', ts }), port, adresse)
    return
  }

  if (typeof brut.t === 'string' && brut.t.startsWith('rdv-')) {
    if (percage.traiter(brut, adresse, port)) return
    if (rendezvous.traiter(brut, adresse, port)) return
    return mesures.refuse()
  }

  return traiterMessage(brut, adresse, port)
}

/** Le meme traitement, qu'on arrive en direct ou dans une enveloppe de relais. */
function traiterMessage(brut, adresse, port) {
  const message = valider(brut)
  if (!message) return mesures.refuse()

  // Seule l'arrivee se passe de jeton.
  if (message.t === 'bonjour') return arrivee(message, adresse, port)

  const joueur = session.parJetonValide(message.jeton, adresse, port)
  if (!joueur) {
    /*
      ⚠️ ON NE DIT PAS « JETON INVALIDE », ON DIT « RECOMMENCE ». Un client qui
         a perdu sa session apres un redemarrage du serveur doit savoir quoi
         faire ; et on ne renseigne pas un curieux sur la validite d'un jeton.
    */
    socket.send(encoder({ t: 'refus', raison: 'session_inconnue' }), port, adresse, () => {})
    return mesures.refuse()
  }

  if (!joueur.autorise()) return mesures.plafonne() // plafond atteint : on ignore, sans couper
  joueur.vuLe = Date.now()

  switch (message.t) {
    case 'etat':
      /*
        ⚠️ LES PAQUETS ARRIVENT DANS LE DESORDRE EN UDP. Sans ce test, une
           position d'il y a 200 ms ecraserait la position actuelle et le
           personnage tremblerait devant les autres joueurs.
      */
      if (message.seq < joueur.seq) return
      /*
        ⚠️ ON MESURE AVANT D'ECRASER. Les trous dans la numerotation sont la
           seule facon de connaitre la perte : une fois `joueur.seq` remplace,
           l'information a disparu.
      */
      joueur.qualite.sequence(message.seq)
      joueur.seq = message.seq
      joueur.pos = message.pos
      joueur.rot = message.rot
      joueur.anim = message.anim
      // Facultatives : un client plus ancien ne les envoie pas, et c'est permis.
      if (message.vit) joueur.vit = message.vit
      if (message.vie !== null) joueur.vie = message.vie
      if (message.posture) joueur.posture = message.posture
      if (message.geste) {
        joueur.geste = message.geste
        // Un geste dure trois secondes, puis il cesse d'etre envoye.
        joueur.gesteJusqua = Date.now() + 3000
      }
      /*
        ⚠️ LE DECALAGE D'HORLOGE SE MESURE, IL NE SE SUPPOSE PAS. Il sert au
           client pour sa compensation de latence ; sans lui, il interpolerait
           par rapport a une horloge qui n'est pas la notre.
      */
      if (message.ts > 0) joueur.decalage = Date.now() - message.ts
      return

    /*
      ⚠️ LE SERVEUR DECIDE, LE CLIENT A SEULEMENT DEMANDE. On verifie
         l'autorite, on applique, puis on repond -- et on diffuse le
         changement a ceux que ca concerne, pas a tout le monde.

      ⚠️ UNE DEMANDE DEJA TRAITEE REND SON ANCIEN RESULTAT. L'UDP duplique et
         le client renvoie quand il ne voit pas de reponse : sans ca, poser un
         objet deux fois en poserait deux.
    */
    case 'entite': {
      if (!session.peut(joueur, 'interagir')) return
      const rejoue = entites.rejouer(message.cle)
      if (rejoue.deja) {
        session.envoyerA(joueur, { t: 'entite-ok', cle: message.cle, ...rejoue.resultat })
        return
      }

      let resultat = { refus: 'inconnu' }

      if (message.action === 'creer' && message.type && message.pos) {
        if (message.type === 'construction' && !session.peut(joueur, 'construire')) {
          resultat = { refus: 'interdit' }
        } else {
          const e = entites.creer({
            type: message.type,
            pos: message.pos,
            rot: message.rot,
            etat: message.etat,
            proprietaire: joueur.id,
          })
          resultat = e ? { id: e.id, rev: e.revision } : { refus: 'type_refuse' }
        }
      } else if (message.action === 'modifier' && message.id) {
        const e = entites.modifier(message.id, message, joueur, 'actionner')
        resultat = e ? { id: e.id, rev: e.revision } : { refus: 'refuse' }
      } else if (message.action === 'supprimer' && message.id) {
        const e = entites.table.get(message.id)
        const permis = entites.autorise(e, joueur, 'posseder')
        resultat = permis && entites.supprimer(message.id)
          ? { id: message.id, supprimee: true }
          : { refus: 'refuse' }
      } else if (message.action === 'prendre' && message.id) {
        const e = entites.table.get(message.id)
        // On ne prend que ce qui n'est a personne : sinon on volerait.
        resultat = e && e.proprietaire === null && entites.donner(message.id, joueur.id)
          ? { id: message.id, proprietaire: joueur.id }
          : { refus: 'deja_prise' }
      } else if (message.action === 'rendre' && message.id) {
        const e = entites.table.get(message.id)
        resultat = e && e.proprietaire === joueur.id && entites.donner(message.id, null)
          ? { id: message.id, proprietaire: null }
          : { refus: 'pas_a_toi' }
      }

      entites.retenir(message.cle, resultat)
      mesures.transactions++
      session.envoyerA(joueur, { t: 'entite-ok', cle: message.cle, ...resultat })
      ressources.emettre('entite', session.vuePourRessource(joueur), message.action, resultat)
      return
    }

    /*
      Creatures. Seul l'hote est ecoute : elles ne vivent que dans SON jeu.

      ⚠️ ON NE REPOND RIEN A UN RAPPORT. Vingt fois par seconde, un accuse de
         reception doublerait le trafic pour une information dont l'absence se
         voit toute seule au rapport suivant.
    */
    case 'pnj': {
      if (!joueur.hote) return
      if (message.action === 'rapport') {
        pnj.rapporter(joueur.id, message.liste)
      } else if (message.action === 'retrait' && message.cle) {
        pnj.retirer(joueur.id, message.cle)
      }
      return
    }

    /*
      Inventaire. Le miroir est une declaration ; le coffre est une
      transaction, et chaque transaction porte une cle.
    */
    case 'inv': {
      if (message.action === 'declarer') {
        inventaires.declarer(joueur.id, message.objets)
        ressources.emettre('inventaire', session.vuePourRessource(joueur), message.objets)
        return
      }

      if (message.action === 'voir') {
        session.envoyerA(joueur, { t: 'coffre', ...inventaires.instantane() })
        return
      }

      const rejoue = inventaires.rejouer(message.cle)
      if (rejoue.deja) {
        session.envoyerA(joueur, { t: 'inv-ok', cle: message.cle, ...rejoue.resultat })
        return
      }

      let resultat
      if (message.action === 'deposer') {
        resultat = inventaires.deposer({ nom: message.nom, nombre: message.nombre, parQui: joueur.nom })
      } else if (message.action === 'retirer') {
        resultat = inventaires.retirer({ nom: message.nom, nombre: message.nombre, parQui: joueur.nom })
      } else {
        // `rendre` : le mod n'a pas reussi a donner l'objet, il revient au coffre.
        resultat = inventaires.rendre({ nom: message.nom, nombre: message.nombre, parQui: joueur.nom })
      }

      inventaires.retenir(message.cle, resultat)
      mesures.transactions++
      session.envoyerA(joueur, { t: 'inv-ok', cle: message.cle, ...resultat })
      if (resultat.ok) {
        session.messageATous(
          message.action === 'deposer'
            ? `${joueur.nom} dépose ${resultat.nombre} ${resultat.nom} dans le coffre commun.`
            : message.action === 'retirer'
              ? `${joueur.nom} prend ${resultat.nombre} ${resultat.nom} dans le coffre commun.`
              : `${resultat.nombre} ${resultat.nom} revient au coffre.`,
        )
      }
      return
    }

    /*
      Un fait ponctuel. Il part a ceux qui sont a portee, et a eux seuls.
    */
    case 'evenement': {
      if (!session.peut(joueur, 'interagir')) return
      const e = evenements.preparer(joueur, message)
      if (!e) return
      mesures.evenements++
      session.diffuserAutour(e)
      const texte = Evenements.texte(e)
      if (texte) {
        /*
          ⚠️ LE TEXTE NE PART QU'A CEUX QUI ONT RECU L'EVENEMENT. Annoncer « une
             alarme sonne » a quelqu'un a deux kilometres serait faux.
        */
        for (const autre of session.joueurs.values()) {
          if (evenements.concerne(e, autre)) session.messageA(autre, texte)
        }
      }
      ressources.emettre('evenement', session.vuePourRessource(joueur), e)
      return
    }

    case 'equipe': {
      const r = executer(
        session,
        joueur,
        message.action === 'pret'
          ? `/pret ${message.valeur ? 'oui' : 'non'}`
          : `/equipe ${message.action} ${message.nom ?? ''}`.trim(),
      )
      if (r) session.messageA(joueur, r)
      return
    }

    case 'activite': {
      const mots = {
        creer: `/activite creer ${[message.titre, ...message.etapes].filter(Boolean).join(' | ')}`,
        demarrer: `/activite demarrer ${message.id}`,
        cocher: `/activite fait ${message.id} ${message.numero}`,
        finir: `/activite finir ${message.id}`,
        oublier: `/activite finir ${message.id}`,
      }
      const r = executer(session, joueur, mots[message.action] ?? '/activite')
      if (r) session.messageA(joueur, r)
      return
    }

    case 'ping': {
      session.envoyerA(joueur, { t: 'pong', ts: message.ts, serveur: Date.now() })
      if (message.ts > 0) {
        const allerRetour = Math.max(0, Math.min(Date.now() - message.ts, 60_000))
        joueur.ping = allerRetour
        joueur.qualite.allerRetour(allerRetour)
      }
      return
    }

    /** Ce que le mod a reussi a faire. Pur diagnostic : rien n'en depend. */
    case 'sonde':
      joueur.faits = message.faits
      return

    case 'chat':
      return chat(joueur, message)

    case 'commande': {
      const reponse = executer(session, joueur, message.texte)
      if (reponse) session.messageA(joueur, reponse)
      ressources.emettre('commande', session.vuePourRessource(joueur), message.texte)
      return
    }

    case 'adieu':
      session.retirer(joueur, 'départ')
      return
  }
}

/**
 * Le chat, avec ses canaux.
 *
 * ⚠️ LE MUSELEMENT SE VERIFIE ICI, PAS A L'ENTREE. Quelqu'un de musele peut
 *    jouer : il ne peut simplement pas parler. Le lui dire une fois suffit —
 *    le repeter a chaque message serait une punition de plus.
 */
function chat(joueur, message) {
  if (!session.peut(joueur, 'parler')) {
    session.messageA(joueur, 'Tu ne peux pas parler sur ce serveur.')
    return
  }
  if (moderation) {
    /*
      ⚠️ DEUX SORTES DE MUSELLEMENT. Celui qui est inscrit, et celui qui ne tient
         que le temps de la connexion — le seul possible quand il n'y a ni
         identité ni adresse propre à épingler.
    */
    if (joueur.muselJusqua && joueur.muselJusqua > Date.now()) {
      session.messageA(joueur, 'Tu ne peux pas parler pour le moment.')
      return
    }
    const musele = moderation.musele(joueur.empreinte, joueur.adresse)
    if (musele) {
      session.messageA(joueur, 'Tu ne peux pas parler pour le moment.')
      return
    }
  }

  const paquet = { t: 'chat', de: joueur.nom, id: joueur.id, texte: message.texte, canal: message.canal }

  if (message.canal === 'prive') {
    const cible = message.a ? session.parNom(message.a) : null
    if (!cible) {
      session.messageA(joueur, 'Personne de ce nom en jeu.')
      return
    }
    session.envoyerA(cible, paquet)
    session.envoyerA(joueur, { ...paquet, a: cible.nom })
    journal.info(`<${joueur.nom} → ${cible.nom}> ${message.texte}`)
    return
  }

  if (message.canal === 'equipe') {
    const eq = equipes.equipeDe(joueur.id)
    if (!eq) {
      session.messageA(joueur, 'Tu n’es dans aucune équipe.')
      return
    }
    paquet.equipe = eq.nom
    for (const id of equipes.membres(eq.id)) {
      const j = session.joueurs.get(id)
      if (j) session.envoyerA(j, paquet)
    }
    journal.info(`<${joueur.nom} [${eq.nom}]> ${message.texte}`)
    return
  }

  if (message.canal === 'local') {
    /*
      ⚠️ « LOCAL » VEUT DIRE QUELQUE CHOSE DE PRECIS : 60 metres, la portee ou
         deux joueurs se voient. Sans distance definie, le canal n'aurait aucun
         sens pour celui qui parle.
    */
    const PORTEE = 6000
    let entendu = 0
    for (const j of session.joueurs.values()) {
      const dx = j.pos.x - joueur.pos.x
      const dy = j.pos.y - joueur.pos.y
      const dz = j.pos.z - joueur.pos.z
      if (dx * dx + dy * dy + dz * dz <= PORTEE * PORTEE) {
        session.envoyerA(j, paquet)
        if (j.id !== joueur.id) entendu++
      }
    }
    journal.info(`<${joueur.nom} (local)> ${message.texte}`)
    if (entendu === 0) session.messageA(joueur, 'Personne n’est assez près pour t’entendre.')
    return
  }

  journal.info(`<${joueur.nom}> ${message.texte}`)
  session.diffuser(paquet)
  ressources.emettre('chat', session.vuePourRessource(joueur), message.texte, message.canal)
}

function arrivee(message, adresse, port) {
  const r = session.accueillir(message, adresse, port)

  if (r.refus) {
    socket.send(
      encoder({ t: 'refus', raison: r.refus, detail: r.detail ?? null, jusqua: r.jusqua ?? 0 }),
      port,
      adresse,
      () => {},
    )
    journal.avis(`arrivee refusee (${r.refus}) depuis ${adresse}`)
    return
  }

  const joueur = r.joueur
  session.envoyerA(joueur, {
    t: 'bienvenue',
    id: joueur.id,
    jeton: joueur.jeton,
    /*
      ⚠️ LE JETON DE REPRISE PART A L'ARRIVEE, PAS AU DEPART. Un depart peut
         etre un plantage : il n'y a alors plus personne a qui le remettre.
    */
    reprise: joueur.jetonReprise,
    nom: joueur.nom,
    hote: joueur.hote,
    spectateur: joueur.spectateur,
    role: session.role(joueur),
    empreinte: joueur.empreinte,
    reprisDeLaPlace: Boolean(r.repris),
    hz: config.hz,
    protocole: config.protocole,
    serveur: config.nom,
    joueurs: [...session.joueurs.values()].map((j) => j.publique()),
    monde: monde.instantane(),
    temps: temps.instantane(),
    equipes: equipes.instantane(),
    activites: activites.instantane(),
    coffre: inventaires.instantane(),
  })
  // Le monde vient d'etre envoye a ce joueur ; les autres l'ont deja.
  session.messageA(joueur, `Bienvenue sur ${config.nom}. Tape /aide pour les commandes.`)

  const motd = monde.donnees.get('motd')
  if (motd) session.messageA(joueur, `Mot du jour : ${motd}`)

  /*
    ⚠️ LE POINT DE RENDEZ-VOUS PART DES L'ARRIVEE. C'est le seul moment ou il
       compte vraiment : le joueur vient de charger sa partie et ne sait pas
       ou sont les autres.
  */
  const rdv = sauvegardes.pointDeRendezVous()
  if (rdv) session.envoyerA(joueur, { t: 'rdv', rdv })
}

// ── Boucles ─────────────────────────────────────────────────────────────────

let minuterieInstantanes = null
let minuterieBalayage = null
let minuterieDisque = null

function demarrer() {
  for (const a of config.avertissements) journal.avis(a)

  socket.on('error', (e) => {
    journal.erreur(`UDP : ${e.message}`)
    arreter(1)
  })

  socket.bind(config.port, config.hote, () => {
    const http = creerHttp(config, session, monde, sauvegardes, {
      rendezvous,
      percage,
      mesures,
      entites,
      pnj,
      equipes,
      activites,
      inventaires,
      identites,
      moderation,
      ressources,
      annuaire,
      temps,
    })

    http.listen(config.portHttp, config.hote, () => {
      journal.info(`${config.nom} — v${config.version}, protocole ${config.protocole} (min ${config.protocoleMinimum})`)
      journal.info(`jeu : UDP ${config.hote}:${config.port}`)
      journal.info(`monde et navigateur : TCP ${config.hote}:${config.portHttp}`)
      journal.info(`${config.maxJoueurs} places, ${config.hz} instantanés/s${config.motDePasse ? ', mot de passe actif' : ''}`)
      journal.info(`transport : ${transport.choisir().nom}`)
      if (config.percage) journal.info(`perçage actif vers ${config.rendezvousAdresse || '(adresse manquante)'}`)
      if (config.rendezvous) journal.info('point de rendez-vous actif sur ce port.')
      if (config.cycleMinutes) journal.info(`cycle jour/nuit : ${config.cycleMinutes} min de jeu par minute réelle`)
      if (permissions.proprietaires.size) {
        journal.info(`${permissions.proprietaires.size} propriétaire(s) déclaré(s) par empreinte.`)
      }

      ressources.chargerTout()
      annuaire.demarrer()
      rendezvous.demarrer()
      percage.demarrer(() => session.etat())
      ressources.emettre('demarrage')

      minuterieInstantanes = setInterval(() => session.instantane(), Math.round(1000 / config.hz))

      minuterieBalayage = setInterval(() => {
        session.balayer()
        // Les entites a duree de vie expirent, et les vieilles cles de
        // transaction cessent d'occuper la memoire.
        entites.balayer()
        pnj.balayer()
        activites.balayer()
        inventaires.balayer()
        moderation.balayer()
        rendezvous.balayer()
        mesures.seconde()

        /*
          ⚠️ CHACUN RECOIT SA PROPRE QUALITE DE LIEN, PAS CELLE DES AUTRES. Un
             joueur n'a aucune raison de connaitre la gigue de son voisin, et
             c'est la sienne qui explique ce qu'il voit a l'ecran.
        */
        if (session.tick % (config.hz * 5) < config.hz) {
          for (const j of session.joueurs.values()) {
            if (!j.sait('reseau')) continue
            session.envoyerA(j, { t: 'reseau', ...j.qualite.rapport(), etat: j.qualite.etat })
          }
        }
        temps.avancer()
        temps.evoluerMeteo()

        /*
          ⚠️ LES EVENEMENTS DE CREATURES PARTENT ICI, PAS DANS L'INSTANTANE. Une
             mort est un fait : elle doit arriver une fois, a tout le monde,
             meme a ceux qui sont loin — alors que l'instantane, lui, est
             filtre par distance.
        */
        const faits = pnj.prendreEvenements()
        if (faits) {
          for (const f of faits) session.diffuser({ t: 'pnj-fait', ...f })
          ressources.emettre('pnj', faits)
        }

        ressources.emettre('seconde')
      }, 1000)

      /*
        ⚠️ LES POSITIONS S'ECRIVENT PAR PAQUETS, PAS A CHAQUE TICK. Vingt fois
           par seconde et par joueur, le disque deviendrait le goulot.
      */
      minuterieDisque = setInterval(() => {
        for (const j of session.joueurs.values()) sauvegardes.retenirPosition(j.nom, j.pos, j.rot)
        sauvegardes.enregistrerSiBesoin()
        identites.enregistrerSiBesoin()
        ressources.enregistrerTousLesEtats()
      }, 15_000)

      ecouterLaConsole()

      // Le mot que l'hebergeur attend pour declarer le serveur en ligne.
      journal.pret()
    })

    http.on('error', (e) => {
      journal.erreur(`TCP ${config.portHttp} : ${e.message}`)
      arreter(1)
    })
  })
}

function arreter(code = 0) {
  clearInterval(minuterieInstantanes)
  clearInterval(minuterieBalayage)
  clearInterval(minuterieDisque)

  /*
    ⚠️ ON ECRIT LES POSITIONS AVANT DE MOURIR. Elles ne partaient sur disque
       que toutes les quinze secondes : un serveur redemarre entre deux
       ecritures perdait tout le monde, et un serveur arrete avant la
       premiere n'avait jamais rien ecrit du tout.
  */
  try {
    for (const j of session.joueurs.values()) sauvegardes.retenirPosition(j.nom, j.pos, j.rot)
    sauvegardes.enregistrerSiBesoin()
    identites.enregistrerSiBesoin()
    moderation.enregistrerSiBesoin()
    inventaires.enregistrerSiBesoin()
    ressources.emettre('arret')
    ressources.enregistrerTousLesEtats()
  } catch (e) {
    journal.avis(`état non enregistré : ${e.message}`)
  }

  try {
    percage.arreter()
    annuaire.arreter()
  } catch {
    /* un annuaire injoignable ne retient pas l'arret */
  }

  session.messageATous('Le serveur s’arrête.')
  try {
    socket.close()
  } catch {
    /* deja ferme */
  }
  journal.info('Arrêté.')
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    journal.info(`Signal ${signal} reçu.`)
    arreter(0)
  })
}

/**
 * La console de l'operateur, sur l'entree standard.
 *
 * ⚠️ SOUS WINDOWS, `kill()` TERMINE LE PROCESSUS D'AUTORITE. Aucun gestionnaire
 *    de signal ne s'execute : les positions ecrites toutes les quinze secondes,
 *    les identites, les sanctions et le coffre perdent leur derniere minute. Une
 *    ligne `stop` sur l'entree standard, elle, marche partout — c'est par la que
 *    le lanceur arrete le serveur qu'il heberge.
 *
 * ⚠️ TOUT LE RESTE EST UNE COMMANDE, AVEC LES DROITS DU PROPRIETAIRE. Celui qui
 *    tient la console tient la machine : lui demander un rôle n'aurait aucun
 *    sens. C'est le meme chemin que `POST /admin/commande`, et le drapeau
 *    `console` ne vient jamais du reseau.
 *
 * ⚠️ ON N'ECOUTE PAS UNE ENTREE QUI N'EXISTE PAS. Sans ce garde-fou, un
 *    environnement sans entree standard declencherait `end` aussitot et le
 *    serveur s'arreterait tout seul au demarrage.
 */
function ecouterLaConsole() {
  if (!process.stdin || process.stdin.destroyed) return

  const operateur = {
    id: 0,
    nom: 'console',
    console: true,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0 },
    hote: true,
    spectateur: false,
    empreinte: null,
    ping: 0,
    faits: {},
    adresse: '127.0.0.1',
  }

  let reste = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (bout) => {
    reste += bout
    let coupure = reste.indexOf('\n')
    while (coupure >= 0) {
      const ligne = reste.slice(0, coupure).replace(/\r$/, '').trim()
      reste = reste.slice(coupure + 1)
      if (ligne) {
        if (/^(stop|arret|arrêt|quit|exit)$/i.test(ligne)) {
          journal.info('Arrêt demandé par la console.')
          arreter(0)
          return
        }
        try {
          const reponse = executer(session, operateur, ligne)
          journal.info(reponse ?? 'fait')
        } catch (e) {
          journal.erreur(`console : ${e instanceof Error ? e.message : e}`)
        }
      }
      coupure = reste.indexOf('\n')
    }
    // Une ligne sans fin ne doit pas gonfler indefiniment.
    if (reste.length > 4096) reste = ''
  })

  process.stdin.on('error', () => {})
  process.stdin.resume()
}

/*
  ⚠️ DERNIER FILET, SYNCHRONE. `process.on('exit')` ne permet aucune operation
     asynchrone, mais nos ecritures sont synchrones : elles passent. Il couvre
     les sorties propres que les signaux ne couvrent pas.
*/
process.on('exit', () => {
  try {
    sauvegardes.enregistrerSiBesoin()
    identites.enregistrerSiBesoin()
    moderation.enregistrerSiBesoin()
    inventaires.enregistrerSiBesoin()
  } catch {
    /* on s'en va de toute facon */
  }
})

/*
  ⚠️ UNE EXCEPTION NON RATTRAPEE NE DOIT PAS TUER LA PARTIE EN SILENCE. On la
     journalise ; si elle se repete, l'hebergeur relancera de toute facon.
*/
process.on('uncaughtException', (e) => journal.erreur(`exception : ${e.stack || e.message}`))
process.on('unhandledRejection', (e) => journal.erreur(`promesse rejetée : ${e}`))

if (require.main === module) demarrer()

module.exports = { demarrer, arreter, session, monde, entites, ressources }
