'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INTERFACE DU LANCEUR
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ AUCUN ACCES DIRECT AU SYSTEME ICI. Tout passe par `window.voyage`, la
 *     passerelle etroite declaree dans `src/passerelle.js`.
 *
 *  ⚠️ AUCUN `innerHTML` AVEC DU TEXTE VENU D'AILLEURS. Un nom de serveur
 *     vient du reseau : il est pose avec `textContent`, sinon un serveur
 *     malveillant injecterait du balisage dans le lanceur de ses joueurs.
 *
 *  ⚠️ CE FICHIER PARTAGE SA PORTEE AVEC `langues.js` (scripts classiques).
 *     Un nom declare des deux cotes fait planter tout le script et laisse
 *     l'interface figee sans erreur visible. Voir le prefixe `LANGUES_`.
 */

const $ = (id) => document.getElementById(id)

let dossierJeu = null
let cibleCourante = null
let lignesLien = []

// ── Messages ────────────────────────────────────────────────────────────────

let minuterieMessage = null
function dire(texte, ton = '') {
  const boite = $('message')
  boite.textContent = texte
  boite.className = `message ${ton}`.trim()
  boite.hidden = false
  clearTimeout(minuterieMessage)
  minuterieMessage = setTimeout(() => (boite.hidden = true), 8000)
}

/**
 * Deroule une reponse de la passerelle, ou affiche l'erreur.
 *
 * ⚠️ LE PROCESSUS PRINCIPAL NE CONNAIT PAS LA LANGUE. Il renvoie une CLE ;
 *    c'est ici qu'on la traduit. Sa phrase francaise ne sert que de filet
 *    si une cle venait a manquer.
 */
function deballer(reponse) {
  if (!reponse?.ok) {
    dire(traduire(reponse?.cle, reponse?.valeurs) ?? reponse?.erreur ?? T('erreur.inconnue'), 'erreur')
    return null
  }
  return reponse.donnees
}

/** Traduit une cle SI elle existe vraiment ; sinon rend null. */
function traduire(cle, valeurs) {
  if (!cle) return null
  const connue = LANGUES_TEXTES.fr[cle] !== undefined
  return connue ? T(cle, valeurs) : null
}

/** Une ligne de journal : soit une cle a traduire, soit du texte deja ecrit. */
function ligneJournal(entree) {
  if (typeof entree === 'string') return entree
  const texte = traduire(entree?.cle, entree?.valeurs) ?? entree?.cle ?? ''
  return entree?.heure ? `${entree.heure} ${texte}` : texte
}

// ── Onglets ─────────────────────────────────────────────────────────────────

for (const bouton of document.querySelectorAll('nav button')) {
  bouton.addEventListener('click', () => {
    for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', 'false')
    bouton.setAttribute('aria-selected', 'true')
    for (const s of document.querySelectorAll('main section')) s.hidden = true
    $(bouton.dataset.onglet).hidden = false
    if (bouton.dataset.onglet === 'serveurs') chargerServeurs()
    if (bouton.dataset.onglet === 'monde') chargerMonde()
  })
}

// ── Etat de l'installation ──────────────────────────────────────────────────

function pastille(element, present, cleOui, cleNon) {
  element.textContent = present ? T(cleOui) : T(cleNon)
  element.className = `etat ${present ? 'ok' : 'manque'}`
}

async function rafraichirEtat() {
  const etat = deballer(await window.voyage.etatJeu())
  if (!etat) return

  if (!etat.trouve) {
    dossierJeu = null
    $('chemin-jeu').textContent = T('inst.introuvable')
    pastille($('etat-jeu'), false, 'inst.trouve', 'inst.absent')
    pastille($('etat-ue4ss'), false, 'inst.installe', 'inst.aFaire')
    pastille($('etat-mod'), false, 'inst.installe', 'inst.aFaire')
    $('reglages-chemin-jeu').textContent = T('inst.introuvable')
    return
  }

  dossierJeu = etat.dossier
  $('chemin-jeu').textContent = `${etat.dossier}  ·  ${etat.source}`
  $('reglages-chemin-jeu').textContent = etat.dossier
  pastille($('etat-jeu'), true, 'inst.trouve', 'inst.absent')
  pastille($('etat-ue4ss'), etat.ue4ss, 'inst.installe', 'inst.aFaire')
  pastille($('etat-mod'), etat.mod, 'inst.installe', 'inst.aFaire')

  const reglages = deballer(await window.voyage.reglages())
  if (reglages?.dossierUe4ss) {
    $('chemin-ue4ss').textContent = reglages.versionUe4ss
      ? `${reglages.versionUe4ss} — ${reglages.dossierUe4ss}`
      : reglages.dossierUe4ss
  }
}

let journalInstall = []
function afficherJournal(lignes) {
  journalInstall = lignes ?? []
  const boite = $('journal')
  boite.textContent = journalInstall.map(ligneJournal).join('\n')
  boite.hidden = journalInstall.length === 0
}

$('btn-choisir-jeu').addEventListener('click', async () => {
  const r = deballer(await window.voyage.choisirJeu())
  if (r && !r.annule) {
    dire(T('inst.dossierEnregistre'), 'bon')
    rafraichirEtat()
  }
})

$('btn-choisir-ue4ss').addEventListener('click', async () => {
  const r = deballer(await window.voyage.choisirUe4ss())
  if (r && !r.annule) {
    dire(T('inst.ue4ssEnregistre'), 'bon')
    rafraichirEtat()
  }
})

// ── Telechargement et installation en un clic ───────────────────────────────

/*
  ⚠️ UNE JAUGE QUI NE BOUGE PAS INQUIETE PLUS QU'ELLE NE RASSURE. Pendant
     l'extraction, GitHub n'envoie plus rien : on bascule le texte sur
     « Extraction… » plutot que de laisser la barre figee a 100 %.
*/
window.voyage.surAvancement(({ pourcent, extraction }) => {
  $('jauge').hidden = false
  $('jauge-remplie').style.width = `${pourcent}%`
  dire(extraction ? T('tele.extraction') : T('tele.enCours', { pourcent }))
})

function occuper(occupe) {
  for (const id of ['btn-tout', 'btn-telecharger-ue4ss', 'btn-desinstaller', 'btn-choisir-jeu', 'btn-choisir-ue4ss']) {
    $(id).disabled = occupe
  }
}

$('btn-telecharger-ue4ss').addEventListener('click', async () => {
  occuper(true)
  const r = deballer(await window.voyage.telechargerUe4ss())
  $('jauge').hidden = true
  occuper(false)
  if (r) dire(T('tele.fini', { version: r.version }), 'bon')
  rafraichirEtat()
})

$('btn-tout').addEventListener('click', async () => {
  occuper(true)
  const r = deballer(await window.voyage.toutInstaller(dossierJeu))
  $('jauge').hidden = true
  occuper(false)
  if (r) {
    afficherJournal(r.journal)
    dire(T('inst.termine'), 'bon')
  }
  rafraichirEtat()
})

$('btn-desinstaller').addEventListener('click', async () => {
  if (!dossierJeu) return dire(T('inst.indiqueJeu'), 'erreur')
  const r = deballer(await window.voyage.desinstaller(dossierJeu))
  if (r) {
    afficherJournal(r.journal)
    dire(T('inst.retire'), 'bon')
  }
  rafraichirEtat()
})

// ── Serveurs ────────────────────────────────────────────────────────────────

function ligneServeur(s) {
  const ligne = document.createElement('div')
  ligne.className = 'ligne'

  const gauche = document.createElement('div')
  const titre = document.createElement('div')
  titre.className = 'titre'
  // textContent : le nom vient du reseau, il n'est jamais interprete.
  titre.textContent = s.enLigne ? s.nom : `${s.hote}:${s.port}`
  const detail = document.createElement('div')
  detail.className = 'detail'
  /*
    ⚠️ ON DIT D'OU VIENT LA CARTE. Un serveur venu de l'annuaire public n'est pas
       un signet du joueur : il peut avoir disparu demain. Le marquer évite qu'il
       le cherche dans sa liste.
  */
  const marques = []
  if (s.motDePasse) marques.push(T('serv.protege'))
  if (s.public) marques.push(T('serv.public'))
  if (s.pays) marques.push(s.pays)

  detail.textContent = s.enLigne
    ? `${s.hote}:${s.port} · ${s.joueurs}/${s.maxJoueurs} ${T('serv.joueurs')} · v${s.version}${
        marques.length ? ` · ${marques.join(' · ')}` : ''
      }`
    : T('serv.muet')
  gauche.append(titre, detail)

  const droite = document.createElement('div')
  droite.className = 'pousse'

  const etat = document.createElement('span')
  etat.className = `etat ${s.enLigne ? 'ok' : ''}`.trim()
  etat.textContent = s.enLigne ? T('serv.enLigne') : T('serv.horsLigne')

  /*
    ⚠️ CONNECTER ET LANCER SONT DEUX GESTES. Le pont doit tourner AVANT que
       le mod cherche son tube ; et le joueur peut vouloir rebrancher sans
       relancer le jeu. Un seul bouton « Jouer » cachait ce rapport.
  */
  const brancher = document.createElement('button')
  brancher.className = 'action principal'
  brancher.textContent = T('serv.connecter')
  brancher.disabled = !s.enLigne
  brancher.addEventListener('click', async () => {
    const motDePasse = s.motDePasse ? window.prompt(T('serv.motDePasse', { nom: s.nom })) : ''
    if (s.motDePasse && motDePasse === null) return
    const r = deballer(await window.voyage.connecter(s.hote, s.port, motDePasse ?? ''))
    if (!r) return
    cibleCourante = r.cible
    montrerLien(r)
    dire(T('lien.demarre'), 'bon')
  })

  const jouer = document.createElement('button')
  jouer.className = 'action'
  jouer.textContent = T('serv.lancer')
  jouer.disabled = !dossierJeu
  jouer.addEventListener('click', async () => {
    deballer(await window.voyage.jouer(dossierJeu))
    dire(T('lien.jeuDemarre'), 'bon')
  })

  /*
    ⚠️ ON NE PROPOSE PAS DE RETIRER CE QU'ON N'A PAS AJOUTE. Un serveur venu de
       l'annuaire n'est pas dans le fichier du joueur : le bouton « Retirer »
       n'aurait rien à retirer, et le serveur réapparaîtrait à l'actualisation
       suivante. On propose l'inverse : le garder.
  */
  const dernier = document.createElement('button')
  dernier.className = 'action discret'
  if (s.public) {
    dernier.textContent = T('serv.garder')
    dernier.addEventListener('click', async () => {
      const r = deballer(await window.voyage.ajouterServeur(`${s.hote}:${s.port}`))
      if (r && !r.ok) return dire(r.erreur, 'erreur')
      dire(T('serv.ajoute'), 'bon')
      chargerServeurs()
    })
  } else {
    dernier.textContent = T('serv.retirer')
    dernier.addEventListener('click', async () => {
      deballer(await window.voyage.retirerServeur(s.hote, s.port))
      chargerServeurs()
    })
  }

  /*
    « Rejoins-moi » devrait être un lien qu'on colle dans Discord, pas une dictée
    de douze chiffres. Le lien ne porte jamais le mot de passe : il dit seulement
    qu'il y en a un.
  */
  const lien = document.createElement('button')
  lien.className = 'action discret'
  lien.textContent = T('serv.lien')
  lien.addEventListener('click', async () => {
    const url = `voyage://join/${s.hote}:${s.port}${s.motDePasse ? '?protege=1' : ''}`
    try {
      await navigator.clipboard.writeText(url)
      dire(T('serv.lienCopie'), 'bon')
    } catch {
      dire(url, 'info')
    }
  })

  /*
    Administrer un serveur distant : la clé reste dans le processus principal,
    la page ne fait que demander.
  */
  const administrer = document.createElement('button')
  administrer.className = 'action discret'
  administrer.textContent = T('serv.administrer')
  administrer.addEventListener('click', () => ouvrirAdministration(s))

  droite.append(etat, brancher, jouer, lien, administrer, dernier)
  ligne.append(gauche, droite)
  return ligne
}

/*
  ⚠️ ON GARDE LA LISTE REÇUE ET ON FILTRE L'AFFICHAGE. Refaire un tour de réseau
     pour cacher trois cartes serait lent, et ferait clignoter la liste à chaque
     clic sur une case.
*/
let serveursRecus = []

function filtrer(liste) {
  const enLigne = $('filtre-enligne')?.checked
  const libres = $('filtre-libres')?.checked
  const ouverts = $('filtre-ouverts')?.checked

  return liste.filter((s) => {
    if (enLigne && !s.enLigne) return false
    if (ouverts && s.motDePasse) return false
    if (libres && s.enLigne && s.joueurs >= s.maxJoueurs) return false
    return true
  })
}

function peindreServeurs() {
  const boite = $('liste-serveurs')
  boite.textContent = ''

  const liste = filtrer(serveursRecus)
  if (liste.length === 0) {
    const rien = document.createElement('div')
    rien.className = 'vide'
    rien.textContent = T(serveursRecus.length === 0 ? 'serv.aucun' : 'serv.aucunFiltre')
    boite.append(rien)
    return
  }
  for (const s of liste) boite.append(ligneServeur(s))
}

for (const id of ['filtre-enligne', 'filtre-libres', 'filtre-ouverts']) {
  const champ = $(id)
  if (champ) champ.addEventListener('change', peindreServeurs)
}

async function chargerServeurs() {
  const boite = $('liste-serveurs')
  boite.textContent = ''
  const vide = document.createElement('div')
  vide.className = 'vide'
  vide.textContent = T('serv.interrogation')
  boite.append(vide)

  serveursRecus = deballer(await window.voyage.serveurs()) ?? []
  peindreServeurs()
}

/*
  ⚠️ ON ACCEPTE UN NOM AUTANT QU'UNE ADRESSE. « Voyage Public 2 » est ce que les
     gens retiennent et se disent ; « 144.217.162.237:30160 » est ce que la
     machine comprend. Demander la seconde forme quand la première suffit, c'est
     transformer « rejoins-moi » en dictée de douze chiffres.

  ⚠️ UNE ADRESSE RESTE UNE ADRESSE. On ne cherche dans l'annuaire que si la
     saisie n'en est pas une : un serveur privé, lui, n'y figure pas, et doit
     continuer de s'ajouter en tapant son adresse.
*/
function ressembleAUneAdresse(texte) {
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(String(texte).trim()) && /[.:]/.test(texte)
}

/**
 * Un billet de rendez-vous : huit caracteres, alphabet sans 0/O ni 1/l.
 *
 * ⚠️ CE N'EST PAS UN SERVEUR QU'ON AJOUTE A SA LISTE. Un billet ne vaut que
 *    tant que l'hote entretient son trou : le garder dans la liste donnerait
 *    une entree morte au prochain demarrage, qui aurait l'air d'une panne.
 *    On se connecte tout de suite, et on ne retient rien.
 */
const ALPHABET_BILLET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function ressembleAUnBillet(texte) {
  const t = String(texte ?? '').trim().toUpperCase()
  if (t.length !== 8) return false
  for (const c of t) if (!ALPHABET_BILLET.includes(c)) return false
  return true
}

async function connecterParBillet(billet) {
  const b = billet.trim().toUpperCase()
  dire(T('serv.billetCherche', { billet: b }), 'info')
  const r = deballer(await window.voyage.connecter('', 0, '', b))
  if (!r) return
  if (r.ok === false) return dire(r.erreur, 'erreur')
  cibleCourante = T('serv.billetCible', { billet: b })
  dire(T('serv.billetEnCours'), 'info')
}

$('btn-ajouter').addEventListener('click', async () => {
  const champ = $('adresse')
  const saisie = champ.value.trim()
  if (!saisie) return

  let aAjouter = saisie

  if (ressembleAUnBillet(saisie)) {
    champ.value = ''
    return connecterParBillet(saisie)
  }

  if (!ressembleAUneAdresse(saisie)) {
    dire(T('serv.cherche', { nom: saisie }), 'info')
    const liste = deballer(await window.voyage.serveurs()) ?? []
    const cible = saisie.toLowerCase()
    const trouve =
      liste.find((x) => String(x.nom ?? x.nomAnnonce ?? '').toLowerCase() === cible) ??
      liste.find((x) => String(x.nom ?? x.nomAnnonce ?? '').toLowerCase().includes(cible))
    if (!trouve) return dire(T('serv.introuvableNom'), 'erreur')
    aAjouter = `${trouve.hote}:${trouve.port}`
  }

  const r = deballer(await window.voyage.ajouterServeur(aAjouter))
  if (!r) return
  if (!r.ok) return dire(r.erreur, 'erreur')
  champ.value = ''
  dire(T('serv.ajoute'), 'bon')
  chargerServeurs()
})

$('adresse').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-ajouter').click()
})

$('btn-rafraichir').addEventListener('click', chargerServeurs)

$('btn-pseudo').addEventListener('click', async () => {
  const r = deballer(await window.voyage.enregistrerNom($('pseudo').value))
  if (!r) return
  $('pseudo').value = r.nom
  dire(T('serv.pseudoOk', { nom: r.nom }), 'bon')
})

$('pseudo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-pseudo').click()
})

// ── Le lien avec le serveur ─────────────────────────────────────────────────

function montrerLien(etat) {
  const actif = Boolean(etat?.actif)
  const cible = etat?.cible ?? cibleCourante
  $('lien-titre').textContent =
    actif && cible ? T('lien.vers', { adresse: `${cible.hote}:${cible.port}` }) : T('lien.pas')
  $('lien-etat').textContent = actif ? T('serv.enLigne') : T('serv.horsLigne')
  $('lien-etat').className = `etat ${actif ? 'ok' : ''}`.trim()
  $('btn-deconnecter').disabled = !actif
  /*
    Le chat, les commandes et le coffre n'ont de sens que relies a un serveur.

    ⚠️ ON DESACTIVE LES CHAMPS, ON NE LES CACHE PAS. Un champ qui disparait
       laisse croire que la fonctionnalite n'existe pas ; un champ grise dit
       qu'il faut d'abord se brancher.
  */
  for (const id of [
    'chat-texte',
    'btn-chat',
    'chat-canal',
    'commande-texte',
    'btn-commande',
    'coffre-objet',
    'coffre-nombre',
    'btn-coffre-deposer',
    'btn-coffre-retirer',
  ]) {
    const champ = $(id)
    if (champ) champ.disabled = !actif
  }

  // Branche ou debranche la lecture reguliere de la partie.
  if (actif) demarrerSuiviDeLaPartie()
  else arreterSuiviDeLaPartie()
  $('lien-detail').textContent = actif ? T('lien.pendant') : T('lien.avant')
  if (etat?.lignes) ecrireJournalLien(etat.lignes)
}

/*
  ⚠️ textContent, PAS innerHTML. Ces lignes viennent du serveur autant que du
     pont : un nom de joueur malveillant ne doit pas devenir du balisage.
*/
function ecrireJournalLien(lignes) {
  lignesLien = lignes.slice(-400)
  const boite = $('lien-journal')
  boite.textContent = lignesLien.map(ligneJournal).join('\n')
  boite.hidden = lignesLien.length === 0
  boite.scrollTop = boite.scrollHeight
}

window.voyage.surDemandeDOnglet((onglet) => {
  const bouton = document.querySelector(`nav button[data-onglet="${CSS.escape(onglet)}"]`)
  if (bouton) bouton.click()
})

window.voyage.surLigneDuLien((ligne) => {
  ecrireJournalLien([...lignesLien, ligne])
  // Le pont annonce lui-meme quand il a trouve le serveur.
  /*
    ⚠️ LE PONT PARLE LA LANGUE DU LANCEUR. Guetter « connecté à » ne marchait
       plus des que le joueur passait en anglais : on reconnait les trois.
  */
  if (/connect(é à|ed to)|conectado a/.test(ligneJournal(ligne))) {
    montrerLien({ actif: true, cible: cibleCourante, lignes: lignesLien })
  }
})

/*
  ⚠️ ON VIDE LE CHAMP AVANT L ENVOI, PAS APRES. Un aller-retour rate laissait
     sinon le message en place, et le joueur appuyait deux fois.
*/
$('chat-forme').addEventListener('submit', async (e) => {
  e.preventDefault()
  const champ = $('chat-texte')
  const texte = champ.value.trim()
  if (!texte) return
  champ.value = ''
  const canal = $('chat-canal') ? $('chat-canal').value : 'global'
  const r = await window.voyage.envoyerChat(texte, canal)
  if (!r || !r.ok) champ.value = texte
})

/*
  Une commande part telle quelle au serveur.

  ⚠️ LE LANCEUR N'INTERPRETE RIEN. C'est le serveur qui dit si la commande
     existe et si le joueur a le droit de la lancer ; sa reponse arrive dans le
     journal du lien, comme en jeu.
*/
$('commande-forme').addEventListener('submit', async (e) => {
  e.preventDefault()
  const champ = $('commande-texte')
  const texte = champ.value.trim()
  if (!texte) return
  champ.value = ''
  const r = await window.voyage.envoyerCommande(texte)
  if (!r || !r.ok) champ.value = texte
})

// ── Le coffre commun ────────────────────────────────────────────

async function bougerLeCoffre(sens) {
  const nom = $('coffre-objet').value.trim()
  if (!nom) return
  const nombre = Number.parseInt($('coffre-nombre').value, 10) || 1
  const r =
    sens === 'deposer'
      ? await window.voyage.deposerAuCoffre(nom, nombre)
      : await window.voyage.retirerDuCoffre(nom, nombre)
  if (r && r.ok) dire(T('coffre.envoye'), 'bon')
}

$('coffre-forme').addEventListener('submit', (e) => {
  e.preventDefault()
  bougerLeCoffre('deposer')
})
$('btn-coffre-retirer').addEventListener('click', () => bougerLeCoffre('retirer'))

// ── La partie en cours ─────────────────────────────────────────

/*
  ⚠️ ON LIT LE SERVEUR, PAS LE PONT. Le pont ne garde pas la liste des equipes
     ni le coffre : il relaie. Le port TCP du serveur, lui, les donne sans
     aucun secret -- ni adresse de joueur, ni empreinte, ni jeton.

  ⚠️ TOUTES LES TROIS SECONDES, PAS PLUS SOUVENT. Ces chiffres changent au
     rythme d'une partie, pas d'une image : interroger dix fois par seconde
     ferait du bruit pour rien.
*/
let minuteriePartie = null

function arreterSuiviDeLaPartie() {
  if (minuteriePartie) clearInterval(minuteriePartie)
  minuteriePartie = null
}

function demarrerSuiviDeLaPartie() {
  if (minuteriePartie) return
  lireLaPartie()
  minuteriePartie = setInterval(lireLaPartie, 3000)
}

function texteOuDefaut(element, texte, cleDefaut) {
  // textContent, pas innerHTML : ces noms viennent du serveur.
  element.textContent = texte || T(cleDefaut)
}

async function lireLaPartie() {
  if (!cibleCourante) return
  const d = await window.voyage.detailServeur(cibleCourante.hote, cibleCourante.port)
  const detail = d && d.ok !== false ? d : null
  if (!detail) return

  const joueurs = detail.joueurs?.joueurs ?? []
  texteOuDefaut(
    $('partie-joueurs'),
    joueurs
      .map((j) => {
        const marques = []
        if (j.hote) marques.push('hôte')
        if (j.spectateur) marques.push('spectateur')
        if (j.equipe) marques.push(j.equipe)
        return `${j.nom}${marques.length ? ` (${marques.join(', ')})` : ''} — ${j.ping} ms`
      })
      .join('  ·  '),
    'partie.vide',
  )
  $('partie-compte').textContent = detail.info
    ? `${detail.info.joueurs}/${detail.info.maxJoueurs}`
    : '—'

  const equipes = detail.equipes?.equipes ?? []
  texteOuDefaut(
    $('partie-equipes'),
    equipes
      .map((e) => `${e.nom} — ${e.membres.length} (${e.prets.length} ${T('partie.pret')})`)
      .join('  ·  '),
    'partie.aucuneEquipe',
  )

  const activites = detail.activites?.activites ?? []
  texteOuDefaut(
    $('partie-activites'),
    activites
      .map((a) => {
        const faites = a.etapes.filter((x) => x.faite).length
        return `n°${a.id} ${a.titre} [${a.etat}] ${faites}/${a.etapes.length}`
      })
      .join('  ·  '),
    'partie.aucuneActivite',
  )

  const coffre = detail.coffre?.coffre ?? []
  texteOuDefaut(
    $('coffre-contenu'),
    coffre.map((o) => `${o.nom} ×${o.nombre}`).join('  ·  '),
    'coffre.vide',
  )

  /*
    ⚠️ UNE MESURE ABSENTE S'AFFICHE COMME ABSENTE, JAMAIS COMME ZERO. Un
       serveur plus ancien n'a pas `/mesures` : afficher « 0 ms de tick »
       ferait croire a la perfection alors que rien n'a ete mesure.
  */
  const m = detail.mesures
  $('partie-mesures').textContent =
    m && m.total
      ? T('partie.mesures', {
          joueurs: joueurs.length,
          entrant: m.reseau ? m.reseau.entrantKoParS : 'N/A',
          tick: m.ticks ? m.ticks.moyenneMs : 'N/A',
          memoire: m.memoireMo,
        })
      : T('partie.mesuresInconnues')
}

// ── L'identite ────────────────────────────────────────────────

async function montrerIdentite() {
  const i = deballer(await window.voyage.identite())
  if (!i) return
  $('ident-empreinte').textContent = i.empreinte
}

$('btn-ident-copier').addEventListener('click', async () => {
  const texte = $('ident-empreinte').textContent.trim()
  if (!texte || texte === '—') return
  try {
    await navigator.clipboard.writeText(texte)
    dire(T('ident.copie'), 'bon')
  } catch {
    /* le presse-papiers peut etre refuse : l'empreinte reste lisible a l'ecran */
  }
})

/*
  ⚠️ ON DEMANDE CONFIRMATION, PARCE QUE C'EST IRREVERSIBLE. Roles, profil et
     heures de jeu sont attaches a l'ancienne empreinte : un clic de trop ne
     doit pas les perdre.
*/
$('btn-ident-refaire').addEventListener('click', async () => {
  if (!window.confirm(T('ident.confirme'))) return
  const i = deballer(await window.voyage.regenererIdentite())
  if (!i) return
  $('ident-empreinte').textContent = i.empreinte
  dire(T('ident.refait', { empreinte: i.empreinte }), 'bon')
})

$('btn-deconnecter').addEventListener('click', async () => {
  const r = deballer(await window.voyage.deconnecter())
  if (r) {
    cibleCourante = null
    montrerLien(r)
    dire(T('lien.arrete'), 'bon')
  }
})


// ── Le monde ────────────────────────────────────────────────────────────────

let serveursConnus = []
let apercuCourant = null

function serveurChoisi() {
  const v = $('monde-serveur').value
  if (!v) return null
  const [hote, port] = v.split(':')
  return { hote, port: Number.parseInt(port, 10) }
}

async function chargerMonde() {
  const local = deballer(await window.voyage.mondeLocal())
  if (!local) return

  $('monde-dossier').textContent = local.dossier ?? T('monde.aucunDossier')
  $('monde-compte').textContent = T('monde.fichiers', { n: local.fichiers.length })
  $('monde-compte').className = `etat ${local.fichiers.length ? 'ok' : 'manque'}`

  // Les serveurs enregistres alimentent la liste deroulante.
  serveursConnus = deballer(await window.voyage.serveurs()) ?? []
  const choix = $('monde-serveur')
  const avant = choix.value
  choix.textContent = ''
  for (const sv of serveursConnus) {
    const o = document.createElement('option')
    o.value = `${sv.hote}:${sv.port}`
    o.textContent = sv.enLigne ? `${sv.nom} (${sv.hote}:${sv.port})` : `${sv.hote}:${sv.port}`
    choix.append(o)
  }
  if (avant) choix.value = avant

  // Les copies de sauvegarde.
  const boite = $('monde-copies')
  boite.textContent = ''
  if (local.copies.length === 0) {
    const rien = document.createElement('div')
    rien.className = 'vide'
    rien.textContent = T('monde.aucuneCopie')
    boite.append(rien)
  } else {
    for (const c of local.copies.slice(0, 12)) boite.append(ligneCopie(c))
  }

  if (serveursConnus.length === 0) {
    $('monde-distant-detail').textContent = T('monde.aucunServeur')
  } else {
    await rafraichirMondeDistant()
  }
}

function ligneCopie(c) {
  const l = document.createElement('div')
  l.className = 'ligne'
  const g = document.createElement('div')
  const t = document.createElement('div')
  t.className = 'titre'
  t.textContent = new Date(c.date).toLocaleString()
  const d = document.createElement('div')
  d.className = 'detail'
  d.textContent = `${c.nom} · ${Math.round(c.taille / 1024)} ko`
  g.append(t, d)

  const p = document.createElement('div')
  p.className = 'pousse'
  const b = document.createElement('button')
  b.className = 'action'
  b.textContent = T('monde.restaurer')
  b.addEventListener('click', async () => {
    const r = deballer(await window.voyage.restaurerMonde(c.chemin))
    if (r) {
      dire(T('monde.restaureOk', { n: r.poses }), 'bon')
      chargerMonde()
    }
  })
  p.append(b)
  l.append(g, p)
  return l
}

async function rafraichirMondeDistant() {
  const cible = serveurChoisi()
  if (!cible) return

  const info = deballer(await window.voyage.mondeDistant(cible.hote, cible.port))
  if (!info) return

  if (!info.present) {
    $('monde-distant-titre').textContent = T('monde.aucunDistant')
    $('monde-distant-detail').textContent = T('monde.choisirServeur')
    $('monde-apercu').hidden = true
    return
  }
  // textContent : ces valeurs viennent du reseau.
  $('monde-distant-titre').textContent = info.nom
  $('monde-distant-detail').textContent = T('monde.publieLe', {
    nom: info.nom,
    par: info.publiePar,
    fichiers: info.fichiers ?? '?',
    ko: Math.round(info.taille / 1024),
    date: new Date(info.date).toLocaleString(),
  })
}

$('monde-serveur').addEventListener('change', rafraichirMondeDistant)

$('btn-monde-dossier').addEventListener('click', async () => {
  const r = deballer(await window.voyage.choisirDossierSauvegardes())
  if (r && !r.annule) chargerMonde()
})

$('btn-monde-coffre').addEventListener('click', async () => {
  const r = deballer(await window.voyage.mettreDeCote())
  if (r) {
    dire(r.copie ? T('monde.copieOk', { chemin: r.copie }) : T('monde.aucuneCopie'), 'bon')
    chargerMonde()
  }
})

$('btn-monde-publier').addEventListener('click', async () => {
  const cible = serveurChoisi()
  if (!cible) return dire(T('monde.aucunServeur'), 'erreur')

  /*
    ⚠️ LE MOT DE PASSE DU MONDE N'EST NI RETENU NI AFFICHE. Il autorise a
       remplacer la partie de tout le monde : il se redemande a chaque fois.
  */
  const motDePasse = window.prompt(T('monde.motDePasseMonde'))
  if (motDePasse === null) return

  $('btn-monde-publier').disabled = true
  const r = deballer(
    await window.voyage.publierMonde(cible.hote, cible.port, {
      motDePasseMonde: motDePasse,
      nom: $('monde-nom').value,
      etiquette: $('monde-etiquette').value,
    }),
  )
  $('btn-monde-publier').disabled = false
  if (r) {
    dire(T('monde.publieOk', { nom: r.nom }), 'bon')
    chargerMonde()
  }
})

$('btn-monde-apercu').addEventListener('click', async () => {
  const cible = serveurChoisi()
  if (!cible) return dire(T('monde.aucunServeur'), 'erreur')

  const sv = serveursConnus.find((x) => x.hote === cible.hote && x.port === cible.port)
  const motDePasse = sv?.motDePasse ? window.prompt(T('serv.motDePasse', { nom: sv.nom })) : ''
  if (sv?.motDePasse && motDePasse === null) return

  $('btn-monde-apercu').disabled = true
  const vue = deballer(await window.voyage.apercuMonde(cible.hote, cible.port, motDePasse ?? ''))
  $('btn-monde-apercu').disabled = false
  if (!vue) return

  apercuCourant = { ...cible, motDePasse: motDePasse ?? '' }
  let texte = T('monde.resume', {
    ajoutes: vue.ajoutes.length,
    remplaces: vue.remplaces.length,
    locaux: vue.chezToiSeulement.length,
  })
  if (vue.remplaces.length) texte += `\n${vue.remplaces.join(', ')}`
  if (vue.refusees.length) {
    texte += `\n${T('monde.refusees', { n: vue.refusees.length, liste: vue.refusees.slice(0, 5).join(', ') })}`
  }
  $('monde-apercu-detail').textContent = texte
  $('monde-apercu').hidden = false
})

$('btn-monde-installer').addEventListener('click', async () => {
  if (!apercuCourant) return
  $('btn-monde-installer').disabled = true
  const r = deballer(
    await window.voyage.installerMonde(apercuCourant.hote, apercuCourant.port, apercuCourant.motDePasse),
  )
  $('btn-monde-installer').disabled = false
  if (!r) return

  dire(T('monde.installeOk', { n: r.poses, etiquette: r.etiquette || '—' }), 'bon')
  const boite = $('monde-journal')
  boite.textContent = [
    T('monde.installeOk', { n: r.poses, etiquette: r.etiquette || '—' }),
    r.copie ? T('monde.copieOk', { chemin: r.copie }) : '',
    r.refusees.length ? T('monde.refusees', { n: r.refusees.length, liste: r.refusees.join(', ') }) : '',
  ]
    .filter(Boolean)
    .join('\n')
  boite.hidden = false
  chargerMonde()
})

// ── Diagnostic ──────────────────────────────────────────────────────────────

function ligneBilan(libelle, bon, texte) {
  const l = document.createElement('div')
  l.className = 'ligne'
  const g = document.createElement('div')
  const t = document.createElement('div')
  t.className = 'titre'
  t.textContent = libelle
  const d = document.createElement('div')
  d.className = 'detail'
  d.textContent = texte
  g.append(t, d)
  const p = document.createElement('div')
  p.className = 'pousse'
  const e = document.createElement('span')
  e.className = `etat ${bon ? 'ok' : 'manque'}`
  e.textContent = bon ? T('diag.oui') : T('diag.non')
  p.append(e)
  l.append(g, p)
  return l
}

$('btn-diagnostic').addEventListener('click', async () => {
  if (!dossierJeu) return dire(T('inst.indiqueJeu'), 'erreur')
  const d = deballer(await window.voyage.diagnostic(dossierJeu))
  if (!d) return

  const boite = $('bilan')
  boite.textContent = ''

  boite.append(
    ligneBilan(
      T('diag.charge'),
      d.ue4ssCharge,
      d.ue4ssCharge ? T('diag.chargeOui', { date: new Date(d.journalDate).toLocaleString() }) : T('diag.chargeNon'),
    ),
  )
  boite.append(ligneBilan(T('diag.modVu'), d.modVu, d.modVu ? T('diag.modVuOui') : T('diag.modVuNon')))
  boite.append(
    ligneBilan(T('diag.rapport'), d.rapportPresent, d.rapportPresent ? T('diag.rapportOui') : T('diag.rapportNon')),
  )

  $('accroche-detail').textContent = d.accroches.length
    ? T('diag.enPlace', { liste: d.accroches.join(', ') })
    : T('diag.aucuneAccroche')

  const choix = $('choix-accroche')
  choix.textContent = ''
  for (const nom of d.pointsPossibles) {
    const o = document.createElement('option')
    o.value = nom
    o.textContent = nom
    if (d.accroches.includes(nom)) o.selected = true
    choix.append(o)
  }

  const boiteRapport = $('rapport')
  boiteRapport.textContent = d.rapport ?? d.extraitJournal ?? ''
  boiteRapport.hidden = !boiteRapport.textContent
})

$('btn-accroche').addEventListener('click', async () => {
  const r = deballer(await window.voyage.changerAccroche(dossierJeu, $('choix-accroche').value))
  if (r) {
    dire(T('diag.accrocheChangee', { nom: r.nom }), 'bon')
    $('btn-diagnostic').click()
  }
})

// ── Reglages ────────────────────────────────────────────────────────────────

function construireChoixLangue(active) {
  const boite = $('choix-langue')
  boite.textContent = ''
  for (const [code, nom] of Object.entries(LANGUES_NOMS)) {
    const b = document.createElement('button')
    b.className = 'langue'
    b.type = 'button'
    b.textContent = nom
    b.setAttribute('aria-pressed', String(code === active))
    b.addEventListener('click', async () => {
      const r = deballer(await window.voyage.changerLangue(code))
      if (!r) return
      LANGUES_appliquer(r.langue)
      construireChoixLangue(r.langue)
      // Les parties construites en JavaScript ne bougent pas toutes seules.
      redessinerApresTraduction()
    })
    boite.append(b)
  }
}

/** Ce que `LANGUES_appliquer` ne peut pas atteindre : tout ce qui est bâti ici. */
function redessinerApresTraduction() {
  rafraichirEtat()
  if (!$('serveurs').hidden) chargerServeurs()
  montrerLien({ actif: !$('btn-deconnecter').disabled, cible: cibleCourante, lignes: lignesLien })
  // Les journaux gardent leurs cles : ils se relisent dans la nouvelle langue.
  afficherJournal(journalInstall)
  if (!$('monde').hidden) chargerMonde()
}

$('btn-ouvrir-jeu').addEventListener('click', async () => {
  if (!dossierJeu) return dire(T('inst.indiqueJeu'), 'erreur')
  deballer(await window.voyage.ouvrirDossier(dossierJeu))
})

// ── Administrer un serveur distant ──────────────────────────────────────────

/*
  ⚠️ LA CLÉ NE PASSE PAS PAR LA PAGE APRÈS AVOIR ÉTÉ POSÉE. On la donne une fois
     au processus principal, qui la garde et l'ajoute lui-même aux requêtes. Une
     page web qui détiendrait des clés d'administration est une page web qui peut
     les perdre.

  ⚠️ UNE CLÉ D'ADMINISTRATION N'EST PAS UN MOT DE PASSE DE SERVEUR. L'une ouvre
     l'administration, l'autre laisse entrer en jeu : les confondre reviendrait à
     donner la première à des joueurs.
*/
async function ouvrirAdministration(serveur) {
  const r = deballer(await window.voyage.adminJoueurs(serveur.hote, serveur.port))

  if (!r || r.ok === false) {
    const cle = window.prompt(T('adm.demandeCle', { nom: serveur.nom ?? `${serveur.hote}:${serveur.port}` }))
    if (cle === null) return
    await window.voyage.poserCleAdmin(serveur.hote, serveur.port, cle)
    const encore = deballer(await window.voyage.adminJoueurs(serveur.hote, serveur.port))
    if (!encore || encore.ok === false) return
    return montrerAdministration(serveur, encore.corps)
  }

  montrerAdministration(serveur, r.corps)
}

function montrerAdministration(serveur, corps) {
  const joueurs = corps?.joueurs ?? []
  const lignes = joueurs.length
    ? joueurs
        .map((j) => {
          const q = j.qualite
          const lien = q && q.rtt !== null ? ` ${q.rtt} ms` : ''
          const perte = q && q.perte !== null && q.perte !== undefined ? `, ${q.perte} % perdu` : ''
          return `${j.nom}${j.hote ? ' (hôte)' : ''}${lien}${perte}`
        })
        .join('\n')
    : T('heb.personne')

  const quoi = window.prompt(
    T('adm.invite', { nom: serveur.nom ?? `${serveur.hote}:${serveur.port}`, joueurs: lignes }),
    '/joueurs',
  )
  if (quoi === null) return

  window.voyage.adminCommande(serveur.hote, serveur.port, quoi).then((rep) => {
    const texte = deballer(rep)
    if (texte && texte.ok !== false) dire(String(texte.corps?.reponse ?? 'fait').slice(0, 240), 'bon')
  })
}

// ── Héberger depuis chez soi ────────────────────────────────────────────────

/*
  ⚠️ C'EST LA SEULE FAÇON D'HÉBERGER AVEC SA PROPRE PARTIE. Sur un serveur loué,
     publier un monde demande le mot de passe de publication, que seul celui qui
     tient l'hébergement possède. Ici le lanceur écrit la sauvegarde directement
     dans le dossier du serveur, avant qu'il démarre.
*/
let lignesHeb = []
let minuterieHeb = null

function ecrireJournalHeb(lignes) {
  lignesHeb = lignes.slice(-400)
  const boite = $('heb-journal')
  // textContent : ces lignes viennent du serveur, jamais interprétées.
  boite.textContent = lignesHeb.map(ligneJournal).join('\n')
  boite.hidden = lignesHeb.length === 0
  boite.scrollTop = boite.scrollHeight
}

window.voyage.surLigneHebergement((ligne) => ecrireJournalHeb([...lignesHeb, ligne]))

function montrerHebergement(etat) {
  const actif = Boolean(etat?.actif)
  const r = etat?.reglages

  $('heb-etat').textContent = actif ? T('serv.enLigne') : T('serv.horsLigne')
  $('heb-etat').className = `etat ${actif ? 'ok' : ''}`.trim()
  $('heb-etat-titre').textContent = actif && r ? T('heb.enMarche', { nom: r.nom, port: r.port }) : T('heb.arrete')
  $('heb-etat-detail').textContent = actif ? T('heb.pendant') : T('heb.avant')

  $('btn-heb-demarrer').disabled = actif
  $('btn-heb-arreter').disabled = !actif
  for (const id of ['heb-nom', 'heb-mdp', 'heb-places', 'heb-port', 'heb-partage', 'heb-public']) {
    const champ = $(id)
    if (champ) champ.disabled = actif
  }
  for (const id of ['heb-cible', 'heb-duree', 'btn-heb-expulser', 'btn-heb-bannir', 'heb-commande', 'btn-heb-commande']) {
    const champ = $(id)
    if (champ) champ.disabled = !actif
  }

  if (etat?.lignes) ecrireJournalHeb(etat.lignes)

  if (actif) demarrerSuiviHebergement()
  else arreterSuiviHebergement()
}

function arreterSuiviHebergement() {
  if (minuterieHeb) clearInterval(minuterieHeb)
  minuterieHeb = null
  $('heb-joueurs').textContent = T('heb.personne')
  $('heb-compte').textContent = '—'
  $('heb-annuaire').textContent = '—'
}

function demarrerSuiviHebergement() {
  if (minuterieHeb) return
  lireLesJoueursHeberges()
  minuterieHeb = setInterval(lireLesJoueursHeberges, 3000)
}

async function lireLesJoueursHeberges() {
  const d = deballer(await window.voyage.joueursHeberges())
  if (!d) return

  const joueurs = d.joueurs ?? []
  $('heb-joueurs').textContent = joueurs.length
    ? joueurs
        .map((j) => {
          const marques = []
          if (j.hote) marques.push('hôte')
          if (j.role && j.role !== 'joueur' && j.role !== 'hote') marques.push(j.role)
          return `${j.nom}${marques.length ? ` (${marques.join(', ')})` : ''} — ${j.ping} ms`
        })
        .join('  ·  ')
    : T('heb.personne')
  $('heb-compte').textContent = String(joueurs.length)

  /*
    ⚠️ L'ANNUAIRE SERT DE TEST DE JOIGNABILITÉ, et c'est sa deuxième utilité. Il
       INTERROGE l'adresse annoncée avant de l'accepter : s'il y arrive, le port
       est bien ouvert ; s'il échoue, il dit pourquoi. Pas besoin d'un service
       séparé pour répondre à « est-ce que mes amis peuvent entrer ? ».
  */
  const a = d.annuaire
  const etatHeb = deballer(await window.voyage.etatHebergement())
  const port = etatHeb?.reglages?.port ?? '?'
  if (!a || !a.actif) {
    $('heb-annuaire').textContent = T('heb.annuaireEteint')
  } else if (a.reussites > 0 && a.echecs === 0) {
    $('heb-annuaire').textContent = T('heb.annuaireOk')
  } else if (a.derniereErreur) {
    $('heb-annuaire').textContent = T('heb.annuaireNon', { raison: a.derniereErreur, port })
  }

  /*
    ⚠️ LE BILLET DOIT SE VOIR, ET UN PERÇAGE MORT AUSSI. Sans cette ligne, le
       billet n'existait que dans une ligne de console qui défile, et un
       rendez-vous qui refuse passait inaperçu : l'hôte aurait attendu des amis
       qui ne pouvaient pas entrer, sans jamais savoir pourquoi.
  */
  const pc = d.percage
  const champPercage = $('heb-percage')
  if (!pc || !pc.actif) {
    champPercage.textContent = pc && pc.refus
      ? T('heb.percageRefus', { raison: pc.refusExplique || pc.refus })
      : T('heb.percageEteint', { port })
  } else if (pc.symetrique) {
    champPercage.textContent = T('heb.percageSymetrique', { port })
  } else if (pc.billet) {
    champPercage.textContent = T('heb.percageBillet', { billet: pc.billet })
  } else {
    champPercage.textContent = T('heb.percageAttente')
  }
}

$('btn-heb-demarrer').addEventListener('click', async () => {
  $('btn-heb-demarrer').disabled = true
  const etat = deballer(
    await window.voyage.demarrerHebergement({
      nom: $('heb-nom').value.trim(),
      motDePasse: $('heb-mdp').value,
      maxJoueurs: $('heb-places').value,
      port: $('heb-port').value,
      partagerLaPartie: $('heb-partage').checked,
      public: $('heb-public').checked,
    }),
  )
  if (!etat) {
    $('btn-heb-demarrer').disabled = false
    return
  }
  montrerHebergement(etat)
})

$('btn-heb-arreter').addEventListener('click', async () => {
  montrerHebergement(deballer(await window.voyage.arreterHebergement()))
})

/*
  Expulser et bannir passent par la console du serveur : c'est LUI qui décide,
  vérifie le rôle et écrit la sanction. La page ne fait que demander.
*/
async function moderer(verbe) {
  const nom = $('heb-cible').value.trim()
  if (!nom) return dire(T('heb.donneCible'), 'erreur')
  const duree = $('heb-duree').value.trim()
  const texte = verbe === 'bannir' ? `/bannir ${nom} ${duree}`.trim() : `/expulser ${nom}`
  const r = await window.voyage.commandeHebergement(texte)
  if (r && r.ok) {
    $('heb-cible').value = ''
    dire(T(verbe === 'bannir' ? 'heb.banni' : 'heb.expulse', { nom }), 'bon')
  }
}

$('btn-heb-expulser').addEventListener('click', () => moderer('expulser'))
$('btn-heb-bannir').addEventListener('click', () => moderer('bannir'))

$('heb-commande-forme').addEventListener('submit', async (e) => {
  e.preventDefault()
  const champ = $('heb-commande')
  const texte = champ.value.trim()
  if (!texte) return
  champ.value = ''
  const r = await window.voyage.commandeHebergement(texte)
  if (!r || !r.ok) champ.value = texte
})

// ── Invitation reçue par un lien `voyage://` ────────────────────────────────

/*
  ⚠️ ON PROPOSE, ON NE REJOINT PAS. Un lanceur qui se brancherait au clic d'un
     lien serait un lanceur qu'on peut télécommander : il suffirait d'un lien
     dans un salon public pour envoyer des gens n'importe où.
*/
let invitationCourante = null

window.voyage.surInvitation((i) => {
  invitationCourante = i
  const protege = i.protege ? T('inv.protege') : ''
  $('invitation-detail').textContent = i.billet
    ? T('inv.billet', { billet: i.billet, protege })
    : T('inv.adresse', { adresse: `${i.hote}:${i.port}`, protege })
  $('invitation').hidden = false
})

$('btn-invitation-ignorer').addEventListener('click', () => {
  invitationCourante = null
  $('invitation').hidden = true
})

$('btn-invitation-rejoindre').addEventListener('click', async () => {
  const i = invitationCourante
  if (!i) return
  $('invitation').hidden = true
  invitationCourante = null

  if (i.billet) {
    // Un billet se saisit dans le champ d'ajout : le lanceur sait le chercher.
    const bouton = document.querySelector('nav button[data-onglet="serveurs"]')
    if (bouton) bouton.click()
    $('adresse').value = ''
    return connecterParBillet(i.billet)
    return
  }

  const motDePasse = i.protege ? window.prompt(T('serv.motDePasse', { nom: `${i.hote}:${i.port}` })) : ''
  if (i.protege && motDePasse === null) return
  const r = deballer(await window.voyage.connecter(i.hote, i.port, motDePasse ?? ''))
  if (!r) return
  cibleCourante = r.cible
  montrerLien(r)
  dire(T('lien.demarre'), 'bon')
})

// ── Mises à jour et pack de soutien ─────────────────────────────────────────

async function verifierMisesAJour(silencieux) {
  const r = deballer(await window.voyage.verifierMaj())
  if (!r) return

  /*
    ⚠️ « ON NE SAIT PAS » N'EST PAS « À JOUR ». Afficher un rassurant « à jour »
       après un échec réseau est exactement le mensonge qui laisse les gens sur
       une vieille version pendant des mois.
  */
  if (r.aJour === null) {
    $('maj-lanceur').textContent = T('maj.echec', { raison: r.raison ?? '?' })
    $('btn-maj-telecharger').hidden = true
    return
  }

  if (r.aJour) {
    $('maj-lanceur').textContent = T('maj.aJour', { v: r.versionLocale })
    $('btn-maj-telecharger').hidden = true
    return
  }

  $('maj-lanceur').textContent = T('maj.disponible', { v: r.versionLocale, nouvelle: r.versionDistante })
  $('btn-maj-telecharger').hidden = false
  if (!silencieux) dire(T('maj.disponible', { v: r.versionLocale, nouvelle: r.versionDistante }), 'info')
}

$('btn-maj-verifier').addEventListener('click', () => verifierMisesAJour(false))

$('btn-maj-telecharger').addEventListener('click', () => {
  window.open('https://caretakermp.symbioseheritage.ca/#telecharger', '_blank')
})

async function verifierLeJeu() {
  if (!dossierJeu) return
  const r = deballer(await window.voyage.versionDuJeu(dossierJeu))
  if (!r || !r.actuel?.build) return

  if (r.change) {
    $('maj-jeu').textContent = T('maj.jeuChange', { avant: r.buildPrecedent, build: r.build })
    dire(T('maj.jeuChange', { avant: r.buildPrecedent, build: r.build }), 'erreur')
  } else if (r.connu) {
    $('maj-jeu').textContent = T('maj.jeuConnu', { build: r.build })
  } else {
    $('maj-jeu').textContent = T('maj.jeuPremier', { build: r.actuel.build })
  }
}

$('btn-soutien').addEventListener('click', async () => {
  const r = deballer(await window.voyage.packDeSoutien(dossierJeu))
  if (!r) return
  dire(T('sout.fait', { nom: r.chemin.split(/[\\/]/).pop() }), 'bon')
})

// ── Demarrage ───────────────────────────────────────────────────────────────

;(async () => {
  const reglages = deballer(await window.voyage.reglages())
  const langue = reglages?.langue ?? (navigator.language || 'fr').slice(0, 2)

  LANGUES_appliquer(LANGUES_NOMS[langue] ? langue : 'fr')
  construireChoixLangue(LANGUES_NOMS[langue] ? langue : 'fr')

  if (reglages?.nomJoueur) $('pseudo').value = reglages.nomJoueur

  const v = deballer(await window.voyage.version())
  if (v) {
    $('pied-version').textContent = `Voyage ${v.version}`
    $('a-propos-version').textContent = T('regl.version', { v: v.version })
  }

  await rafraichirEtat()

  /*
    L'identite se lit au demarrage : le fichier est cree au premier passage, et
    c'est l'empreinte que l'hote d'un serveur demandera.
  */
  /*
    ⚠️ LE CHOIX NE S'APPLIQUE QU'A LA PROCHAINE CONNEXION. Le mode part au pont
       au moment ou il demarre ; le changer pendant qu'une partie tourne ne
       toucherait rien, et laisser croire le contraire serait pire que de le
       dire. F2 en jeu, lui, bascule tout de suite.
  */
  /*
    ⚠️ CES RÉGLAGES NE S'APPLIQUENT QU'À LA PROCHAINE CONNEXION. Ils partent au
       pont au moment où il démarre ; les changer pendant qu'une partie tourne ne
       toucherait rien, et laisser croire le contraire serait pire que de le dire.
  */
  const pl = reglages?.plaques ?? {}
  $('pl-noms').checked = pl.noms !== false
  $('pl-distance').checked = pl.distance !== false
  $('pl-ping').checked = pl.ping === true
  $('pl-vie').checked = pl.vie === true
  $('pl-portee').value = pl.portee ?? 80
  $('dbg-actif').checked = reglages?.debug === true

  const poserPlaques = async () => {
    await window.voyage.changerPlaques({
      noms: $('pl-noms').checked,
      distance: $('pl-distance').checked,
      ping: $('pl-ping').checked,
      vie: $('pl-vie').checked,
      portee: $('pl-portee').value,
    })
  }
  for (const id of ['pl-noms', 'pl-distance', 'pl-ping', 'pl-vie', 'pl-portee']) {
    $(id).addEventListener('change', poserPlaques)
  }
  $('dbg-actif').addEventListener('change', async (e) => {
    await window.voyage.changerDebug(e.target.checked)
  })

  $('choix-creatures').value = reglages?.creatures ?? 'miroir'
  $('choix-creatures').addEventListener('change', async (e) => {
    await window.voyage.changerCreatures(e.target.value)
  })

  await montrerIdentite()

  /*
    On remet les réglages d'hébergement d'une fois sur l'autre : personne n'a
    envie de retaper le nom de son serveur à chaque ouverture.
  */
  const h = reglages?.hebergement ?? {}
  $('heb-nom').value = h.nom ?? (reglages?.nomJoueur ? `Partie de ${reglages.nomJoueur}` : '')
  $('heb-mdp').value = h.motDePasse ?? ''
  $('heb-places').value = h.maxJoueurs ?? 4
  $('heb-port').value = h.port ?? 7777
  $('heb-partage').checked = h.partagerLaPartie !== false
  $('heb-public').checked = Boolean(h.public)

  montrerHebergement(deballer(await window.voyage.etatHebergement()))

  /*
    ⚠️ LA VÉRIFICATION DE VERSION NE DOIT PAS RETENIR LE DÉMARRAGE. Hors ligne,
       le lanceur s'ouvre exactement pareil ; la carte dira simplement qu'elle
       n'a pas pu savoir.
  */
  verifierMisesAJour(true)
  verifierLeJeu()

  const etatLien = deballer(await window.voyage.etatLien())
  if (etatLien) {
    cibleCourante = etatLien.cible
    montrerLien(etatLien)
  }
})()
