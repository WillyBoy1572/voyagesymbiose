# Voyage Lanceur

Lanceur du mod coopératif **Symbiose Voyage** pour *The Last Caretaker*.

Le jeu est solo. Le mod ajoute la coopération jusqu'à quatre joueurs : les
positions et l'état du monde passent par un serveur dédié.

Ce dépôt contient l'intégralité de ce que l'installeur dépose sur la machine du
joueur. Rien n'en est retiré.

## Pourquoi un exécutable

Le mod a deux moitiés, inséparables :

1. **Deux scripts Lua UE4SS** (`mods/`) qui tournent dans le jeu et écrivent
   dans un tube nommé Windows. Seuls, ils ne font rien : le Lua d'UE4SS n'a
   aucune interface réseau.
2. **Un pont** (`pont/pont.js`) qui lit ce tube et parle en UDP au serveur.

C'est cette seconde moitié qui impose un programme. Livrer les scripts Lua seuls
donnerait un mod incapable de faire quoi que ce soit.

## Ce que le lanceur contacte

Trois destinations, toutes sur le serveur que le joueur a lui-même choisi :

| Quoi | Quand |
|---|---|
| UDP vers le serveur | pendant la partie — c'est le multijoueur |
| `http://<serveur>/info` | pour afficher le nombre de joueurs et la présence d'un mot de passe |
| `http://<serveur>/…` | pour prendre ou déposer le monde partagé, à la demande du joueur |

Aucune télémétrie, aucune statistique, aucun rapport d'erreur, aucune mise à
jour automatique, aucun domaine codé en dur. L'adresse du serveur est saisie par
le joueur.

## UE4SS est livré, pas téléchargé

*The Last Caretaker* tourne sur Unreal 5.8, que seules les compilations
expérimentales d'UE4SS prennent en charge ; la v3.0.1 « stable » de février 2024
ne le connaît pas. Ces compilations sont publiées sous un tag roulant dont
l'archive est remplacée régulièrement : aller la chercher voudrait dire que
chaque joueur reçoit une version différente, jamais testée.

Le lanceur embarque donc une compilation fixe, `ressources/ue4ss/`, dont
l'empreinte SHA-256 est vérifiée avant toute extraction. UE4SS est publié sous
licence MIT ; sa notice accompagne l'archive.

## L'installation ne touche pas aux mods des autres

- Si UE4SS est déjà en place — installé à la main ou par l'extension Vortex du
  jeu — il est **laissé tel quel**. Le lanceur ajoute seulement ses deux
  dossiers de mods à côté des autres.
- `mods.txt` reçoit une ligne, il n'est jamais réécrit.
- Les réglages d'un UE4SS existant ne sont pas modifiés.
- La désinstallation retire nos deux mods et nos lignes. UE4SS n'est retiré que
  si c'est le lanceur qui l'a posé, ce qu'indique une marque déposée à
  l'installation.

## Construire

```
npm install
npm run batir     # dist/Voyage-Lanceur-<version>-installeur.exe
npm run essais    # détection, traductions, sauvegardes, contenu du paquet
```

## Licence

Le code de ce dépôt appartient à Symbiose Héritage Hosting ; il est publié pour
pouvoir être lu et vérifié. UE4SS, dans `ressources/ue4ss/`, reste sous sa
propre licence MIT, dont la notice est livrée avec lui.
