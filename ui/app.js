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
  detail.textContent = s.enLigne
    ? `${s.hote}:${s.port} · ${s.joueurs}/${s.maxJoueurs} ${T('serv.joueurs')} · v${s.version}${
        s.motDePasse ? ` · ${T('serv.protege')}` : ''
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

  const retirer = document.createElement('button')
  retirer.className = 'action discret'
  retirer.textContent = T('serv.retirer')
  retirer.addEventListener('click', async () => {
    deballer(await window.voyage.retirerServeur(s.hote, s.port))
    chargerServeurs()
  })

  droite.append(etat, brancher, jouer, retirer)
  ligne.append(gauche, droite)
  return ligne
}

async function chargerServeurs() {
  const boite = $('liste-serveurs')
  boite.textContent = ''
  const vide = document.createElement('div')
  vide.className = 'vide'
  vide.textContent = T('serv.interrogation')
  boite.append(vide)

  const liste = deballer(await window.voyage.serveurs())
  boite.textContent = ''

  if (!liste || liste.length === 0) {
    const rien = document.createElement('div')
    rien.className = 'vide'
    rien.textContent = T('serv.aucun')
    boite.append(rien)
    return
  }
  for (const s of liste) boite.append(ligneServeur(s))
}

$('btn-ajouter').addEventListener('click', async () => {
  const champ = $('adresse')
  const r = deballer(await window.voyage.ajouterServeur(champ.value))
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

  const etatLien = deballer(await window.voyage.etatLien())
  if (etatLien) {
    cibleCourante = etatLien.cible
    montrerLien(etatLien)
  }
})()
