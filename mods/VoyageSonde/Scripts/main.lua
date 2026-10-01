--[[
═══════════════════════════════════════════════════════════════════════════
  VOYAGE — SONDE DE RECONNAISSANCE
═══════════════════════════════════════════════════════════════════════════
  A poser dans :  <Jeu>\Binaries\Win64\ue4ss\Mods\VoyageSonde\Scripts\main.lua

  Elle ne modifie RIEN dans le jeu et ne connecte personne : elle regarde,
  elle note, et elle ecrit `VoyageSonde.txt` a cote de l'executable.

  ⚠️ ELLE NE DEPEND PLUS D'UNE TOUCHE. La premiere version attendait F8 ; si
     le raccourci n'arrive jamais — fenetre pas focalisee, touche deja prise,
     mod charge avant le jeu — le joueur croit que rien ne marche. Elle
     reessaie donc toute seule jusqu'a trouver le pion, puis s'arrete.

  ⚠️ PAS DE DUMP COMPLET. « Dump Objects » d'UE4SS crache des centaines de Mo
     dont 99 % sont du moteur Unreal standard.

  ⚠️ TOUT EST EN pcall. Une erreur Lua dans un mod UE4SS peut figer le jeu au
     chargement ; ici le pire est une ligne « echec » dans le rapport.
═══════════════════════════════════════════════════════════════════════════
]]

local NOM = "VoyageSonde"
local ESSAIS_MAX = 40        -- 40 x 15 s = 10 minutes de patience
local INTERVALLE_MS = 15000

local essais = 0
local fini = false
local lignes = {}

local function noter(texte)
    lignes[#lignes + 1] = texte
    print("[" .. NOM .. "] " .. texte .. "\n")
end

--- Appelle une fonction en attrapant tout, et rend une valeur de repli.
local function sur(f, repli)
    local ok, r = pcall(f)
    if ok and r ~= nil then return r end
    return repli
end

local function estValide(o)
    return o ~= nil and sur(function() return o:IsValid() end, false)
end

local function nomComplet(objet)
    if not estValide(objet) then return "(invalide)" end
    return sur(function() return objet:GetFullName() end, "(sans nom)")
end

--- La chaine d'heritage : c'est elle qui dit quoi accrocher.
local function hierarchie(objet)
    local sortie, classe, garde = {}, sur(function() return objet:GetClass() end, nil), 0
    while estValide(classe) and garde < 12 do
        sortie[#sortie + 1] = sur(function() return classe:GetFName():ToString() end, "?")
        classe = sur(function() return classe:GetSuperStruct() end, nil)
        garde = garde + 1
    end
    return table.concat(sortie, " < ")
end

local function vecteur(v)
    if not v then return "(rien)" end
    return string.format("X=%.1f  Y=%.1f  Z=%.1f", v.X or 0, v.Y or 0, v.Z or 0)
end

local function ecrireRapport()
    local f = io.open("VoyageSonde.txt", "w")
    if not f then
        print("[" .. NOM .. "] impossible d'ecrire VoyageSonde.txt\n")
        return
    end
    f:write(table.concat(lignes, "\n") .. "\n")
    f:close()
    print("[" .. NOM .. "] rapport ecrit : VoyageSonde.txt\n")
end

--- Cherche le pion du joueur par trois chemins differents.
local function trouverPion()
    local pc = sur(function() return FindFirstOf("PlayerController") end, nil)
    if estValide(pc) then
        local p = sur(function() return pc.Pawn end, nil)
        if estValide(p) then return p, pc end
        p = sur(function() return pc:K2_GetPawn() end, nil)
        if estValide(p) then return p, pc end
    end
    local c = sur(function() return FindFirstOf("Character") end, nil)
    if estValide(c) then return c, pc end
    return nil, pc
end

local function sonder()
    if fini then return end
    essais = essais + 1

    local pion, pc = trouverPion()
    if not estValide(pion) then
        if essais == 1 then
            print("[" .. NOM .. "] en attente d'une partie chargee...\n")
        end
        if essais < ESSAIS_MAX then
            ExecuteWithDelay(INTERVALLE_MS, function() pcall(sonder) end)
        else
            print("[" .. NOM .. "] abandon : aucun pion trouve apres " .. essais .. " essais.\n")
        end
        return
    end

    fini = true
    lignes = {}
    noter("=== SONDE VOYAGE ===")
    noter("date : " .. os.date("%Y-%m-%d %H:%M:%S") .. "   (essai no " .. essais .. ")")

    noter("World : " .. nomComplet(sur(function() return FindFirstOf("World") end, nil)))
    noter("PlayerController : " .. nomComplet(pc))
    if estValide(pc) then noter("  heritage : " .. hierarchie(pc)) end

    noter("Pion du joueur : " .. nomComplet(pion))
    noter("  heritage : " .. hierarchie(pion))
    noter("  position : " .. vecteur(sur(function() return pion:K2_GetActorLocation() end, nil)))
    noter("  rotation : " .. vecteur(sur(function() return pion:K2_GetActorRotation() end, nil)))

    -- Les classes propres au jeu, pas celles du moteur.
    noter("")
    noter("--- Classes « Voyage » reperees ---")
    local vues, compte = {}, 0
    for _, a in ipairs(sur(function() return FindAllOf("Actor") end, {}) or {}) do
        if compte >= 40 then break end
        local n = sur(function() return a:GetClass():GetFName():ToString() end, nil)
        if n and n:find("Voyage") and not vues[n] then
            vues[n] = true
            compte = compte + 1
            noter("  " .. n)
        end
    end
    if compte == 0 then noter("  (aucune)") end

    --[[
      ⚠️ CE BLOC EST LA RECONNAISSANCE QUI MANQUE POUR LE BOUTON « CHARGER »
         DANS LE JEU. Tant qu'on ne connait pas le nom exact des UFunction
         de sauvegarde du jeu, la seule facon de charger un monde reste de
         repasser par SON menu. On ne devine pas ces noms : on les lit.

      ⚠️ ON PARCOURT `Children`, PAS UN DUMP D'OBJETS. Le « Dump Objects »
         d'UE4SS fait des centaines de Mo dont 99 % de moteur standard.
    ]]
    noter("")
    noter("--- Fonctions de sauvegarde / chargement ---")
    --[[
      ATTENTION : ON CHERCHE AUSSI LES VERBES DU JEU, PAS SEULEMENT LA
      SAUVEGARDE. Une fonction nommee `OnDeath`, `AddItem` ou `PlaceStructure`
      est exactement ce qu il faudra accrocher pour repliquer une mort, un
      inventaire ou une construction. Les deviner serait une perte de temps ;
      les lire coute un parcours deja fait.
    ]]
    local interessant = {
        -- sauvegarde et session
        "save", "load", "world", "session", "travel", "quit", "continue", "newgame",
        -- vie et mort
        "death", "die", "kill", "damage", "health", "respawn", "revive", "hurt",
        -- inventaire et objets
        "item", "inventory", "pickup", "drop", "equip", "craft", "stack", "slot",
        -- armes
        "weapon", "fire", "shoot", "reload", "ammo", "aim",
        -- construction
        "build", "place", "construct", "destroy", "repair", "upgrade",
        -- interaction
        "interact", "use", "open", "close", "toggle", "activate", "power",
    }
    local vuesF, compteF = {}, 0

    local function fouiller(objet, etiquette)
        if not estValide(objet) then return end
        local classe = sur(function() return objet:GetClass() end, nil)
        while estValide(classe) and compteF < 260 do
            local nomClasse = sur(function() return classe:GetFName():ToString() end, "?")
            -- On s'arrete aux classes du moteur : elles n'ont rien de propre au jeu.
            if nomClasse == "Object" or nomClasse == "Actor" then break end

            local enfant = sur(function() return classe.Children end, nil)
            while estValide(enfant) and compteF < 260 do
                local nf = sur(function() return enfant:GetFName():ToString() end, nil)
                if nf then
                    local bas = nf:lower()
                    for _, mot in ipairs(interessant) do
                        local cle = nomClasse .. ":" .. nf
                        if bas:find(mot) and not vuesF[cle] then
                            vuesF[cle] = true
                            compteF = compteF + 1
                            noter("  " .. etiquette .. " " .. nomClasse .. " : " .. nf)
                            break
                        end
                    end
                end
                enfant = sur(function() return enfant.Next end, nil)
            end

            classe = sur(function() return classe.SuperStruct end, nil)
        end
    end

    fouiller(pc, "[controleur]")
    fouiller(pion, "[pion]")
    fouiller(sur(function() return FindFirstOf("GameModeBase") end, nil), "[mode]")
    fouiller(sur(function() return FindFirstOf("GameInstance") end, nil), "[instance]")
    fouiller(sur(function() return FindFirstOf("GameStateBase") end, nil), "[etat]")
    fouiller(sur(function() return StaticFindObject("/Script/Engine.Default__GameplayStatics") end, nil), "[statics]")

    if compteF == 0 then noter("  (aucune reperee)") end

    --[[
      ⚠️ DEUX QUESTIONS OUVERTES, ET ON ARRETE DE LES DEVINER.

      1. LES ANIMATIONS. Les joueurs distants apparaissent deja comme de vrais
         pions de la classe du joueur : ils PORTENT donc le blueprint
         d'animation du jeu. S'ils glissent sans bouger les jambes, ce n'est
         pas qu'il manque une animation a repliquer -- c'est que
         `K2_TeleportTo` pose la position sans toucher a la vitesse, et qu'un
         blueprint d'animation lit la vitesse. Si on peut ecrire
         `CharacterMovement.Velocity`, les jambes partent toutes seules et il
         n'y a RIEN a repliquer de plus que ce qu'on envoie deja.

      2. LES NOMS AU-DESSUS DES TETES. Le seul texte qu'UE4SS sait afficher
         est `PrintString`, dans un coin de l'ecran. Un vrai panneau dans le
         monde demande `TextRenderComponent` ou `WidgetComponent`. Savoir
         lesquelles de ces classes existent decide entre « vrai nameplate » et
         « repli ».
    ]]
    --[[
      RECENSEMENT DU MONDE CHARGE (pour la 0.6.3 et la suite).

      ATTENTION : ON NE REPLIQUERA PAS CE QU ON N A PAS IDENTIFIE. Synchroniser
      un monstre, une arme ou un mur demande de savoir quelle classe il porte,
      quelles proprietes il expose et ce qui marque son changement d etat. On
      liste donc ce qui existe VRAIMENT dans la partie chargee.

      ATTENTION : UN SEUL PARCOURS DES ACTEURS, ET DES COMPTES PAR CLASSE. Un
      monde charge contient des dizaines de milliers d acteurs ; les lister un
      par un donnerait un fichier illisible et ferait ramer le jeu. On compte,
      on classe, on garde un exemple de chaque.

      ATTENTION : TOUT EST BORNE. Chaque liste a un plafond : une sonde qui
      bloque le chargement du jeu ne sert a personne.
    ]]
    noter("")
    noter("--- Recensement du monde ---")

    local familles = {
        creature     = { "character", "enemy", "monster", "creature", "npc", "zombie",
                         "drone", "bot", "spawner", "swarm", "hostile", "predator" },
        arme         = { "weapon", "gun", "rifle", "pistol", "ammo", "projectile", "bullet",
                         "melee", "blade", "turret", "explosive", "grenade" },
        construction = { "build", "construct", "place", "blueprint", "structure", "foundation",
                         "wall", "floor", "roof", "deploy", "snap", "module", "piece" },
        actionnable  = { "door", "switch", "lever", "valve", "button", "terminal", "station",
                         "machine", "generator", "cable", "pipe", "panel", "console", "interact" },
        inventaire   = { "inventory", "item", "slot", "container", "storage", "chest",
                         "crate", "loot", "pickup", "resource", "craft" },
        vehicule     = { "vehicle", "boat", "ship", "raft", "submarine", "drive", "seat" },
        monde        = { "weather", "time", "daynight", "tide", "wave", "ocean", "island" },
    }

    local comptes, exemples = {}, {}
    local census = {}
    local tousLesActeurs = sur(function() return FindAllOf("Actor") end, {}) or {}
    noter("  acteurs parcourus : " .. tostring(#tousLesActeurs))

    for _, a in ipairs(tousLesActeurs) do
        local nomC = sur(function() return a:GetClass():GetFName():ToString() end, nil)
        if nomC then
            census[nomC] = (census[nomC] or 0) + 1
            local bas = nomC:lower()
            for famille, mots in pairs(familles) do
                for _, mot in ipairs(mots) do
                    if bas:find(mot, 1, true) then
                        local cle = famille .. "|" .. nomC
                        comptes[cle] = (comptes[cle] or 0) + 1
                        if exemples[cle] == nil then exemples[cle] = a end
                        break
                    end
                end
            end
        end
    end

    -- Par famille, pour que le rapport se lise.
    for famille in pairs(familles) do
        local lignesF = {}
        for cle, combien in pairs(comptes) do
            local f, nomC = cle:match("^(%a+)|(.+)$")
            if f == famille then lignesF[#lignesF + 1] = { nomC, combien, exemples[cle] } end
        end
        if #lignesF > 0 then
            table.sort(lignesF, function(x, y) return x[2] > y[2] end)
            noter("")
            noter("  [" .. famille:upper() .. "]")
            for k = 1, math.min(#lignesF, 14) do
                noter(string.format("    %-46s x%d", lignesF[k][1], lignesF[k][2]))
            end
            -- Un exemple detaille par famille : sa hierarchie dit quoi accrocher.
            local ex = lignesF[1][3]
            if ex then
                noter("    exemple : " .. hierarchie(ex))
                noter("    position: " .. vecteur(sur(function() return ex:K2_GetActorLocation() end, nil)))
            end
        end
    end

    --[[
      Les classes les plus nombreuses, meme sans mot-cle. C est souvent la que
      se cache ce qu on cherche : un jeu nomme rarement ses classes comme on
      s y attend.
    ]]
    noter("")
    noter("  [LES PLUS NOMBREUSES, tous noms confondus]")
    local tri = {}
    for nomC, combien in pairs(census) do tri[#tri + 1] = { nomC, combien } end
    table.sort(tri, function(x, y) return x[2] > y[2] end)
    for k = 1, math.min(#tri, 25) do
        noter(string.format("    %-46s x%d", tri[k][1], tri[k][2]))
    end

    --[[
      LES COMPOSANTS ET LES PROPRIETES DU PION.

      ATTENTION : C EST ICI QU ON APPRENDRA QUOI REPLIQUER. Sante, faim,
      oxygene, inventaire, equipement : si le jeu les porte sur le pion, leurs
      noms apparaissent ci-dessous. Sans cette liste on devinerait.
    ]]
    noter("")
    noter("--- Composants portes par le pion ---")
    local composants = sur(function() return pion:K2_GetComponentsByClass(StaticFindObject("/Script/Engine.ActorComponent")) end, nil)
    if composants and #composants > 0 then
        for k = 1, math.min(#composants, 30) do
            noter("  " .. (sur(function() return composants[k]:GetFName():ToString() end, "?"))
                .. "  <" .. (sur(function() return composants[k]:GetClass():GetFName():ToString() end, "?")) .. ">")
        end
    else
        noter("  (liste indisponible par K2_GetComponentsByClass)")
    end

    noter("")
    noter("--- Proprietes du pion, du controleur et de l etat de partie ---")

    local function proprietes(objet, etiquette, plafond)
        if not estValide(objet) then
            noter("  " .. etiquette .. " : (absent)")
            return
        end
        local classe = sur(function() return objet:GetClass() end, nil)
        local poses, garde = 0, 0
        while estValide(classe) and poses < plafond and garde < 10 do
            local nomClasse = sur(function() return classe:GetFName():ToString() end, "?")
            if nomClasse == "Object" or nomClasse == "Actor" then break end
            -- UE5 range les proprietes dans `ChildProperties`, les fonctions dans `Children`.
            local p = sur(function() return classe.ChildProperties end, nil)
            while estValide(p) and poses < plafond do
                local np = sur(function() return p:GetFName():ToString() end, nil)
                if np then
                    poses = poses + 1
                    noter(string.format("  %s %-34s (%s)", etiquette, np, nomClasse))
                end
                p = sur(function() return p.Next end, nil)
            end
            classe = sur(function() return classe.SuperStruct end, nil)
            garde = garde + 1
        end
        if poses == 0 then noter("  " .. etiquette .. " : (aucune propriete lisible)") end
    end

    proprietes(pion, "[pion]", 60)
    proprietes(pc, "[controleur]", 25)
    proprietes(sur(function() return FindFirstOf("PlayerState") end, nil), "[etat joueur]", 25)
    proprietes(sur(function() return FindFirstOf("GameStateBase") end, nil), "[etat partie]", 25)

    noter("")
    noter("--- Animations : la vitesse est-elle accessible ? ---")

    local vit = sur(function() return pion:GetVelocity() end, nil)
    noter("  GetVelocity()            : " .. (vit and vecteur(vit) or "INDISPONIBLE"))

    local mouvement = sur(function() return pion.CharacterMovement end, nil)
    if not estValide(mouvement) then
        mouvement = sur(function() return pion.MovementComponent end, nil)
    end
    if estValide(mouvement) then
        noter("  composant de mouvement   : " .. nomComplet(mouvement))
        noter("    heritage               : " .. hierarchie(mouvement))
        local v = sur(function() return mouvement.Velocity end, nil)
        noter("    .Velocity (lecture)    : " .. (v and vecteur(v) or "INDISPONIBLE"))
        -- Ecriture : on repose la valeur lue, donc rien ne bouge pour le joueur.
        local ecrivable = false
        if v then
            ecrivable = sur(function()
                mouvement.Velocity = { X = v.X, Y = v.Y, Z = v.Z }
                return true
            end, false)
        end
        noter("    .Velocity (ecriture)   : " .. (ecrivable and "POSSIBLE" or "refusee"))
        noter("    MaxWalkSpeed           : " .. tostring(sur(function() return mouvement.MaxWalkSpeed end, "indisponible")))
    else
        noter("  composant de mouvement   : INTROUVABLE")
    end

    local maille = sur(function() return pion.Mesh end, nil)
    if not estValide(maille) then maille = sur(function() return pion:GetMesh() end, nil) end
    if estValide(maille) then
        noter("  maille (Mesh)            : " .. nomComplet(maille))
        local anim = sur(function() return maille.AnimScriptInstance end, nil)
        noter("    AnimScriptInstance     : " .. (estValide(anim) and nomComplet(anim) or "INDISPONIBLE"))
    else
        noter("  maille (Mesh)            : INTROUVABLE")
    end

    noter("")
    noter("--- Noms au-dessus des tetes : quelles classes existent ? ---")

    local candidates = {
        { "TextRenderComponent", "/Script/Engine.TextRenderComponent" },
        { "WidgetComponent",     "/Script/UMG.WidgetComponent" },
        { "UserWidget",          "/Script/UMG.UserWidget" },
        { "TextBlock",           "/Script/UMG.TextBlock" },
        { "HUD",                 "/Script/Engine.HUD" },
        { "CanvasPanel",         "/Script/UMG.CanvasPanel" },
    }
    for _, c in ipairs(candidates) do
        local trouvee = sur(function() return StaticFindObject(c[2]) end, nil)
        noter(string.format("  %-22s : %s", c[1], estValide(trouvee) and "PRESENTE" or "absente"))
    end

    -- Un HUD vivant permettrait de dessiner sans rien instancier.
    local hud = sur(function() return FindFirstOf("HUD") end, nil)
    noter("  HUD actif en jeu       : " .. (estValide(hud) and nomComplet(hud) or "aucun"))
    if estValide(hud) then noter("    heritage             : " .. hierarchie(hud)) end

    --[[
      ⚠️ CONNAITRE LE NOM D'UNE FONCTION NE SUFFIT PAS POUR L'APPELER. Il
         faut ses parametres, dans l'ordre, avec leur type : un appel avec
         le mauvais nombre d'arguments passe par-dessus la pile d'Unreal et
         fait tomber le jeu. On les lit plutot que de les deviner.

      ⚠️ ON NE DEMANDE QUE CE DONT ON A BESOIN. Dumper la signature de tout
         le moteur donnerait des megaoctets illisibles.
    ]]
    noter("")
    noter("--- Signatures qui nous interessent ---")

    local voulues = {
        "TravelToWorldWithSaveGame",
        "TravelToWorldWithGameProgess",
        "InitFreshNewGameProgress",
        "LoadGameFromSlot",
        "SaveGameToSlot",
        "DoesSaveGameExist",
        "CreateSaveGameObject",
    }

    --- Les parametres d'une UFunction, dans l'ordre declare.
    local function signature(fonction)
        local bouts = {}
        local champ = sur(function() return fonction.ChildProperties end, nil)
        local garde = 0
        while estValide(champ) and garde < 24 do
            garde = garde + 1
            local nomP = sur(function() return champ:GetFName():ToString() end, "?")
            local typeP = sur(function() return champ:GetClass():GetFName():ToString() end, "?")
            bouts[#bouts + 1] = nomP .. " : " .. typeP
            champ = sur(function() return champ.Next end, nil)
        end
        if #bouts == 0 then return "(aucun parametre visible)" end
        return table.concat(bouts, ", ")
    end

    local function chercherDans(objet, etiquette)
        if not estValide(objet) then return end
        local classe = sur(function() return objet:GetClass() end, nil)
        local profondeur = 0
        while estValide(classe) and profondeur < 12 do
            profondeur = profondeur + 1
            local nomClasse = sur(function() return classe:GetFName():ToString() end, "?")
            local enfant = sur(function() return classe.Children end, nil)
            local garde = 0
            while estValide(enfant) and garde < 400 do
                garde = garde + 1
                local nf = sur(function() return enfant:GetFName():ToString() end, nil)
                if nf then
                    for _, voulue in ipairs(voulues) do
                        if nf == voulue then
                            noter("  " .. etiquette .. " " .. nomClasse .. " : " .. nf)
                            noter("      " .. signature(enfant))
                        end
                    end
                end
                enfant = sur(function() return enfant.Next end, nil)
            end
            classe = sur(function() return classe.SuperStruct end, nil)
        end
    end

    chercherDans(sur(function() return FindFirstOf("GameInstance") end, nil), "[instance]")
    chercherDans(sur(function() return StaticFindObject("/Script/Engine.Default__GameplayStatics") end, nil), "[statics]")

    -- Le nom exact de l'instance de jeu : c'est sur elle qu'on appellera.
    local gi = sur(function() return FindFirstOf("GameInstance") end, nil)
    noter("")
    noter("instance de jeu : " .. nomComplet(gi))

    -- Ou le jeu range ses sauvegardes, vu de l'interieur.
    noter("")
    noter("--- Sauvegardes ---")
    local ldd = os.getenv("LOCALAPPDATA")
    noter("dossier attendu : " .. (ldd and (ldd .. "\\Voyage\\Saved\\SaveGames") or "(LOCALAPPDATA inconnu)"))

    noter("")
    noter("--- Points d'accroche connus ---")
    local porte = sur(function() return StaticFindObject("/Script/Voyage.VoyageDoorActor") end, nil)
    noter("VoyageDoorActor : " .. (estValide(porte) and "PRESENT" or "absent"))

    noter("")
    noter("=== FIN ===")
    ecrireRapport()
end

-- Premier essai 10 s apres le chargement, puis toutes les 15 s.
ExecuteWithDelay(10000, function() pcall(sonder) end)

-- F8 reste disponible pour forcer, mais plus rien n'en depend.
pcall(function()
    RegisterKeyBind(Key.F8, function()
        fini = false
        essais = 0
        pcall(sonder)
    end)
end)

print("[" .. NOM .. "] chargee. Elle cherchera toute seule des qu'une partie sera ouverte.\n")
