# Voyage Lanceur — tester le lien

## 1. Installer

Un seul fichier : **`Voyage-Lanceur-0.6.1-installeur.exe`** (84 Mo).
Il pose le lanceur, un raccourci bureau et un raccourci menu Démarrer.

Windows affichera « Éditeur inconnu » : l'exécutable n'est pas signé. Pour le
faire disparaître il faut un certificat de signature de code, qui s'achète
(~300 $/an, ou ~100 $ en OV chez certains revendeurs). Tant qu'on n'en a pas,
c'est « Informations complémentaires » → « Exécuter quand même ».

## 2. Tout installer — un clic

Ouvre le lanceur, onglet **Installation**, bouton **Tout installer**.

Il fait tout seul :

1. trouve le jeu par le registre Steam et `libraryfolders.vdf` ;
2. télécharge UE4SS depuis GitHub (la build `experimental-latest`, la seule
   qui connaisse Unreal 5.8 — la « v3.0.1 stable » date de février 2024) ;
3. l'installe dans `…\Voyage\Voyage\Binaries\Win64` avec nos deux mods ;
4. vérifie que tout est bien en place, et le dit si ce n'est pas le cas.

Tu n'as plus rien à télécharger à la main.

## 3. Se connecter AVANT de jouer

Onglet **Serveurs** :

1. ton **pseudo**, « Enregistrer » ;
2. ajoute `192.168.0.50:30150` ;
3. **Connecter** sur la ligne du serveur.

La carte « Le lien » passe en vert et affiche `connecté à « Serveur Voyage »`.

> L'ordre compte : le pont doit tourner avant que le mod cherche son tube.
> Lancé après, ce n'est pas grave — le mod retente toutes les 2 s.

## 4. Lancer le jeu et **charger une partie**

**Lancer le jeu**, puis charge une sauvegarde.

Au **menu**, rien n'est envoyé : c'est voulu. Le jeu y tourne déjà avec un
monde vide (`/Game/Maps/Empty.Empty`) et un pion factice immobile en 0,0,0 ;
sans ce filtre, tous les joueurs apparaîtraient empilés à l'origine.

## Jouer à plusieurs

Chacun fait la même chose, sur sa machine :

1. installe le lanceur, **Tout installer** ;
2. met **son** pseudo (deux joueurs du même nom sont indistinguables) ;
3. ajoute la même adresse de serveur ;
4. **Connecter** ;
5. lance le jeu et **charge une partie**.

Vous devez alors vous voir. Chacun apparaît chez l'autre sous la forme du
même personnage que le jeu vous donne — le mod ne devine aucune apparence,
il copie celle de votre propre pion.

> ⚠️ **Chargez chacun VOTRE propre sauvegarde.** Le monde n'est pas encore
> synchronisé : seuls les joueurs le sont. Ce que l'un construit ou ramasse
> n'apparaît pas chez l'autre. C'est la prochaine étape.

### Comment ça marche, en une phrase

Le Lua d'UE4SS n'a pas de sockets. Le mod **écrit** sa position dans un tube
nommé, le pont fait le réseau, puis **dépose** les autres joueurs dans un
petit fichier que le mod relit dix fois par seconde. Il ne lit jamais le
tube : une lecture de tube bloque, et le blocage aurait lieu dans le fil de
jeu — le jeu se figerait.

### Si personne n'apparaît

Ouvre la console du jeu et cherche une ligne comme :

```
[VoyageLien] apparition impossible, etape « BeginDeferredActorSpawnFromClass ».
```

**Envoie-moi cette ligne.** Elle nomme l'étape exacte qui a échoué. Les
appels au moteur sont la seule partie que je ne peux pas essayer d'ici : le
jeu ne tourne pas sur le serveur. Tout le reste du trajet est vérifié par
`essais/retour.py`, qui fait passer une position réelle du serveur jusqu'à
l'analyseur Lua du mod.

## Se retrouver — lis ça avant de tester à deux

**Le serveur est hébergé : personne n'y joue.** Il n'a donc aucune position
« de l'hôte » qui servirait de point d'arrivée. Chacun charge SA sauvegarde
et atterrit où elle dit — à des kilomètres l'un de l'autre, avec un lien qui
marche parfaitement et personne en vue.

D'où le **point de retrouvailles** :

| Touche | Ce qu'elle fait |
|---|---|
| **F3** | pose le point de retrouvailles là où tu es |
| **F5** | t'emmène près du joueur le plus proche, sinon au point posé |

La marche à suivre, à deux :

1. le premier entre en partie et appuie sur **F3** ;
2. le second entre, puis appuie sur **F5** — il arrive à côté.

Le point est retenu par le serveur : il survit aux redémarrages, et le
second joueur peut arriver bien plus tard.

> **On ne te téléporte jamais tout seul.** Déplacer quelqu'un à son arrivée,
> c'est le sortir de sa partie sans lui demander — et si le point vient d'un
> autre monde, c'est le jeter dans le vide. Le serveur propose, tu appuies.

Tu arrives **à côté** et un peu au-dessus, jamais exactement sur l'autre :
atterrir sur ses coordonnées exactes, c'est apparaître dans lui ou dans le
sol qu'il occupe.

Depuis le chat du jeu, `/rdv` dit à quelle distance il est, `/rdv poser` le
fixe, `/rdv oublier` l'efface.

## Le monde partagé

Onglet **Monde**. Il fait trois choses, et une quatrième qui compte autant.

### Côté hôte — publier ta partie

1. Le lanceur trouve ton dossier `SaveGames` tout seul (il est dans ton
   profil, `%LOCALAPPDATA%\\Voyage\\Saved\\SaveGames`, pas dans le jeu).
2. Donne un nom au monde, puis **Publier**.
3. Il demande le **mot de passe du monde** — ce n'est PAS celui du serveur.
   Celui du serveur laisse entrer ; celui du monde autorise à **remplacer la
   partie de tout le monde**. Ils sont séparés exprès.

Côté serveur, il faut un mot de passe du monde. **Sans lui, publier est
refusé** — il n'y a pas de valeur par défaut, parce qu'un défaut serait un
défaut connu de tous.

L'egg du panneau n'expose pas `MONDE_MOTDEPASSE` : le serveur lit donc aussi
un fichier. Dans le gestionnaire de fichiers du panneau, crée

```
donnees/motdepasse-monde.txt
```

avec ton mot de passe sur la première ligne, puis redémarre. La console dira
`mot de passe du monde lu dans donnees/motdepasse-monde.txt.` et
`/monde/info` passera à `"publicationOuverte": true`.

C'est toi qui le choisis : je n'en invente pas un à ta place, et un mot de
passe que j'aurais écrit serait dans cette conversation.

### Côté joueur — installer le monde de l'hôte

1. **Aperçu** : il télécharge l'archive, vérifie son empreinte SHA-256, et
   te dit ce qui va changer — combien de fichiers ajoutés, **remplacés**, et
   gardés chez toi.
2. **Installer ce monde** : une copie de ta partie est faite d'abord,
   automatiquement, dans `Documents\\..\\Voyage-Sauvegardes-Symbiose`. Ce
   n'est pas une option.
3. Retourne au menu du jeu et charge la partie indiquée.

### Revenir en arrière

Toutes les copies sont listées en bas de l'onglet, avec un bouton
**Restaurer**. Le serveur garde aussi le monde publié précédent.

### Ce que ça n'est pas

C'est de la **synchronisation par fichiers de sauvegarde**, pas un monde
vivant partagé. Quand tu installes, tu prends la partie de l'hôte à
l'instant où il l'a publiée. Si deux personnes construisent chacune de leur
côté, seule la prochaine publication l'emporte. Les **joueurs** sont en
direct ; le **monde** est un instantané.

## Les positions sont retenues

Le serveur garde la dernière position de chacun, par pseudo, et la rend
quand tu reviens : les autres te revoient là où tu étais, pas à l'origine du
monde. Elles s'écrivent sur disque **au départ du joueur**, pas seulement sur
une minuterie — un serveur qui tombe ne perd rien.

> Le pseudo est la seule identité qu'on a : le jeu ne nous en donne aucune
> autre. Deux personnes qui prennent le même pseudo partagent leur position.

## Le menu en jeu

| Touche | Ce qu'elle fait |
|---|---|
| **F4** | rappelle ces touches à l'écran |
| **F6** | qui est en partie avec toi |
| **F7** | installer le monde du serveur |
| **F9** | publier ta partie (ouvre le lanceur) |
| **F8** | relance la sonde de diagnostic |

Le texte s'affiche dans un coin de l'écran, via `PrintString`. UE4SS ne
permet pas de dessiner une vraie fenêtre à la souris depuis Lua — pas
d'ImGui, et construire un widget à la main demanderait un travail démesuré
pour le résultat.

**F7 et F9 ne touchent jamais au disque depuis le jeu.** Le mod envoie une
demande au lanceur par le même tube ; c'est le lanceur qui fait la copie de
sécurité, vérifie l'archive et répond. Écraser des sauvegardes pendant
qu'une partie tourne n'est pas quelque chose qu'un mod doit décider seul.

F9 ouvre la fenêtre du lanceur plutôt que de publier : le mot de passe du
monde n'est jamais gardé en mémoire, il faut le retaper.

## Ce qui reste

- **Le monde n'est pas vivant.** Voir plus haut : instantané, pas partage.
- **Charger une partie depuis le jeu** sans repasser par son menu. On tient
  la fonction : `VoyageGameInstance : TravelToWorldWithSaveGame`, avec
  `TravelToWorldWithGameProgess` et `InitFreshNewGameProgress` a cote, plus
  le trio standard `LoadGameFromSlot` / `SaveGameToSlot` / `DoesSaveGameExist`.

  Il manque leurs **parametres**. La sonde les liste maintenant, section
  « Signatures qui nous interessent » de `VoyageSonde.txt` — relance le jeu
  une fois et envoie-moi ce bloc.

  > Je n'appelle pas une fonction du moteur en devinant ses arguments : un
  > appel avec le mauvais nombre de parametres ecrase la pile d'Unreal et
  > fait tomber le jeu. On lit la signature, puis on appelle.
- Les inventaires, les constructions, les PNJ : rien de tout ça n'est
  synchronisé.
- **Le texte affiché en jeu est en français seulement.** Le lanceur parle
  trois langues, le mod une seule — il n'a pas de dictionnaire.

## 5. Ce qui prouve que ça marche

- Dans le lanceur : `envoyé N positions` qui monte.
- Dans la console du jeu : `[VoyageLien] en partie : … — envoi en cours.`
- Puis, quand un autre arrive : `[VoyageLien] Maple apparait.`
- Dans un navigateur : <http://192.168.0.50:30151/joueurs>.

## La console du jeu

Ce **n'est pas F8**. UE4SS annonce trois touches :
**celle à gauche du 1**, **² / ~**, ou **F10**.

## Langues

Onglet **Réglages** : français, anglais, espagnol. Le choix est retenu.

## Si rien ne part

Onglet **Diagnostic**, **Analyser**. Il lit `UE4SS.log` et dit laquelle des
trois étapes manque. Si UE4SS ne se charge pas du tout, change le **point
d'accroche** (`dwmapi.dll` par défaut) et relance le jeu.

---

## Sur la marque

L'icône et l'en-tête reprennent la **charte** du jeu — couleurs relevées sur
les captures officielles, panneaux noirs à filet blanc, étiquettes orange,
barre verte — mais **le dessin est le nôtre** : une tête de gardien stylisée.

Le logo « THE LAST CARETAKER » de Channel37 est leur propriété ; le
redistribuer dans un installeur qu'on met en ligne est autre chose que s'en
inspirer. Si tu veux quand même leur logo, remplace
`ressources/voyage.ico` et `ui/marque.svg` et rebâtis — c'est ton appel,
mais je préférais ne pas le faire sans te le dire.

## Rebâtir

```
npm run batir
node essais/paquet.js
```
