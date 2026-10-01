--[[
═══════════════════════════════════════════════════════════════════════════
  VOYAGE — SONDE DE RECONNAISSANCE
═══════════════════════════════════════════════════════════════════════════
  A poser dans :  <Jeu>\Binaries\Win64\ue4ss\Mods\VoyageSonde\Scripts\main.lua

  Elle ne modifie RIEN dans le jeu et ne connecte personne : elle regarde,
  elle note, et elle ecrit `VoyageSonde.txt` a cote de l'executable.

  ⚠️ ELLE NE DEPEND PAS D'UNE TOUCHE. La premiere version attendait F8 ; si
     le raccourci n'arrive jamais — fenetre pas focalisee, touche deja prise,
     mod charge avant le jeu — le joueur croit que rien ne marche. Elle
     reessaie donc toute seule jusqu'a trouver le pion, puis s'arrete.

  ⚠️ ELLE IGNORE LE MENU. Le jeu tourne deja au menu, avec un pion a (0,0,0)
     dans `Maps/Empty` : une sonde qui s'en contente rend un rapport qui a
     l'air complet et ne decrit rien.

  ⚠️ PAS DE DUMP COMPLET. « Dump Objects » d'UE4SS crache des centaines de Mo
     dont 99 % sont du moteur Unreal standard.

  ⚠️ TOUT EST EN pcall. Une erreur Lua dans un mod UE4SS peut figer le jeu au
     chargement ; ici le pire est une ligne « echec » dans le rapport.

  ⚠️ ELLE ESSAIE, ELLE NE SUPPOSE PAS. Pour les questions qui decident de la
     suite — peut-on ecrire la vitesse, peut-on creer une plaque de nom, quels
     crochets prennent, que contient le composant d'inventaire — elle fait
     vraiment le geste, note le resultat, et defait ce qu'elle a fait. Une liste
     de classes « presentes » ne dit pas si l'appel passe ; seul l'appel le dit.
═══════════════════════════════════════════════════════════════════════════
]]

local NOM = "VoyageSonde"
local ESSAIS_MAX = 120       -- 120 x 15 s = 30 minutes : le temps de charger une partie
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

local function nomDeClasse(objet)
    if not estValide(objet) then return "" end
    return sur(function() return objet:GetClass():GetFName():ToString() end, "")
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

--[[
  Parcourt une TArray venue d'Unreal.

  ⚠️ UN ELEMENT DE TArray N'EST PAS L'OBJET, C'EST UN ENVELOPPE. C'est la raison
     pour laquelle la version precedente de cette sonde rendait trente lignes
     « ? <?> » a la place des composants du pion : elle faisait `liste[k]` et
     appelait `GetFName()` dessus. `ForEach` passe un enveloppe dont `:get()`
     rend l'objet reel. On essaie `ForEach` d'abord, et l'indexation ensuite
     pour les versions d'UE4SS qui n'en ont pas.
]]
local function pourChaque(tableau, rappel, plafond)
    if tableau == nil then return 0 end
    local vus = 0
    local ok = pcall(function()
        tableau:ForEach(function(_, enveloppe)
            if plafond and vus >= plafond then return end
            local objet = sur(function() return enveloppe:get() end, nil)
            if objet == nil then objet = enveloppe end
            vus = vus + 1
            rappel(objet)
        end)
    end)
    if ok and vus > 0 then return vus end

    -- Repli : indexation directe.
    local combien = sur(function() return #tableau end, 0)
    for i = 1, math.min(combien, plafond or combien) do
        local e = sur(function() return tableau[i] end, nil)
        if e ~= nil then
            local objet = sur(function() return e:get() end, nil) or e
            vus = vus + 1
            rappel(objet)
        end
    end
    return vus
end

--[[
  Les proprietes d'une classe ou d'une fonction.

  ⚠️ `ChildProperties` NE MARCHE PAS SOUS UE5. Les proprietes y sont des
     `FField`, qui ne sont pas des `UObject` : la reflexion d'UE4SS ne les voit
     pas par ce chemin. C'est pour ca que la version precedente ecrivait
     « (aucune propriete lisible) » alors que le pion en porte des dizaines, et
     « (aucun parametre visible) » pour toutes les signatures.
     `ForEachProperty` est le chemin exact ; on garde les deux autres pour les
     versions plus anciennes du moteur.
]]
local function pourChaquePropriete(structure, rappel, plafond)
    if not estValide(structure) then return 0 end
    local vus = 0

    local ok = pcall(function()
        structure:ForEachProperty(function(propriete)
            if plafond and vus >= plafond then return end
            vus = vus + 1
            local nom = sur(function() return propriete:GetFName():ToString() end, "?")
            local type = sur(function() return propriete:GetClass():GetFName():ToString() end, "?")
            rappel(nom, type)
        end)
    end)
    if ok and vus > 0 then return vus end

    -- Repli 1 : la chaine `ChildProperties` (UE5, quand elle est exposee).
    local p = sur(function() return structure.ChildProperties end, nil)
    local garde = 0
    while estValide(p) and garde < (plafond or 200) do
        garde = garde + 1
        vus = vus + 1
        rappel(
            sur(function() return p:GetFName():ToString() end, "?"),
            sur(function() return p:GetClass():GetFName():ToString() end, "?")
        )
        p = sur(function() return p.Next end, nil)
    end
    if vus > 0 then return vus end

    -- Repli 2 : `PropertyLink` (UE4).
    p = sur(function() return structure.PropertyLink end, nil)
    garde = 0
    while estValide(p) and garde < (plafond or 200) do
        garde = garde + 1
        vus = vus + 1
        rappel(
            sur(function() return p:GetFName():ToString() end, "?"),
            sur(function() return p:GetClass():GetFName():ToString() end, "?")
        )
        p = sur(function() return p.PropertyLinkNext end, nil)
    end
    return vus
end

--- Les fonctions d'une classe, en remontant l'heritage.
local function pourChaqueFonction(objet, rappel, plafond)
    if not estValide(objet) then return 0 end
    local vus = 0
    local classe = sur(function() return objet:GetClass() end, nil)
    local profondeur = 0

    while estValide(classe) and profondeur < 12 and (not plafond or vus < plafond) do
        profondeur = profondeur + 1
        local nomClasse = sur(function() return classe:GetFName():ToString() end, "?")

        local fait = pcall(function()
            classe:ForEachFunction(function(fonction)
                if plafond and vus >= plafond then return end
                vus = vus + 1
                rappel(nomClasse, sur(function() return fonction:GetFName():ToString() end, "?"), fonction)
            end)
        end)

        if not fait then
            -- Repli : `Children`, qui sous UE5 ne contient QUE les fonctions.
            local enfant = sur(function() return classe.Children end, nil)
            local garde = 0
            while estValide(enfant) and garde < 400 and (not plafond or vus < plafond) do
                garde = garde + 1
                vus = vus + 1
                rappel(nomClasse, sur(function() return enfant:GetFName():ToString() end, "?"), enfant)
                enfant = sur(function() return enfant.Next end, nil)
            end
        end

        classe = sur(function() return classe:GetSuperStruct() end, nil)
            or sur(function() return classe.SuperStruct end, nil)
    end
    return vus
end

--- Les parametres d'une UFunction, dans l'ordre declare.
local function signature(fonction)
    local bouts = {}
    pourChaquePropriete(fonction, function(nom, type)
        bouts[#bouts + 1] = nom .. " : " .. type
    end, 24)
    if #bouts == 0 then return "(aucun parametre visible)" end
    return table.concat(bouts, ", ")
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
    if estValide(pc) and nomDeClasse(pc):find("Menu") then return nil, pc, true end

    if estValide(pc) then
        local p = sur(function() return pc.Pawn end, nil)
        if not estValide(p) then p = sur(function() return pc:K2_GetPawn() end, nil) end
        if estValide(p) then
            local n = nomDeClasse(p)
            if n:find("Menu") then return nil, pc, true end
            if not n:find("NPC") then return p, pc, false end
        end
    end

    local c = sur(function() return FindFirstOf("Character") end, nil)
    if estValide(c) then
        local n = nomDeClasse(c)
        if not n:find("Menu") and not n:find("NPC") then return c, pc, false end
    end
    return nil, pc, false
end

local function sonder()
    if fini then return end
    essais = essais + 1

    local pion, pc, auMenu = trouverPion()
    if not estValide(pion) then
        if essais == 1 or auMenu then
            print("[" .. NOM .. "] " .. (auMenu and "au menu — charge une partie, je recommence tout seul." or "en attente d'une partie chargee...") .. "\n")
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

    -- ══ 1. LES ESSAIS QUI DECIDENT DE LA SUITE ════════════════════════════
    --[[
      ⚠️ CE BLOC VIENT EN PREMIER PARCE QU'IL EST LE PLUS UTILE. Trois questions
         decident de ce qu'on peut livrer : la vitesse est-elle ecrivable (les
         animations), peut-on creer une plaque de nom (les noms au-dessus des
         tetes), et quels crochets prennent (interactions, mort, inventaire,
         construction). On y repond en FAISANT, pas en listant.
    ]]
    noter("")
    noter("=== ESSAIS REELS ===")

    noter("")
    noter("--- 1a. Animations : la vitesse est-elle ecrivable ? ---")

    local vit = sur(function() return pion:GetVelocity() end, nil)
    noter("  GetVelocity()            : " .. (vit and vecteur(vit) or "INDISPONIBLE"))

    local mouvement, parQuoi = nil, nil
    for _, chemin in ipairs({ "CharacterMovement", "CharMoveComp", "MovementComponent" }) do
        local m = sur(function() return pion[chemin] end, nil)
        if estValide(m) then
            mouvement, parQuoi = m, "." .. chemin
            break
        end
    end
    if not estValide(mouvement) then
        local m = sur(function() return pion:GetCharacterMovement() end, nil)
        if estValide(m) then mouvement, parQuoi = m, "GetCharacterMovement()" end
    end

    if estValide(mouvement) then
        noter("  composant de mouvement   : " .. nomComplet(mouvement))
        noter("    atteint par            : " .. tostring(parQuoi))
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
        noter("    IsFalling()            : " .. tostring(sur(function() return mouvement:IsFalling() end, "indisponible")))
        noter("    IsSwimming()           : " .. tostring(sur(function() return mouvement:IsSwimming() end, "indisponible")))
    else
        noter("  composant de mouvement   : INTROUVABLE")
    end

    local maille = sur(function() return pion.Mesh end, nil)
    if not estValide(maille) then maille = sur(function() return pion:GetMesh() end, nil) end
    if estValide(maille) then
        noter("  maille (Mesh)            : " .. nomComplet(maille))
        local anim = sur(function() return maille.AnimScriptInstance end, nil)
        noter("    AnimScriptInstance     : " .. (estValide(anim) and nomComplet(anim) or "INDISPONIBLE"))
        if estValide(anim) then
            --[[
              ⚠️ LES VARIABLES DU BLUEPRINT D'ANIMATION SONT LA VRAIE REPONSE A
                 « QUOI REPLIQUER ». Si l'instance expose `Speed`, `bIsCrouched`
                 ou `Direction`, on sait exactement ce que le blueprint lit — et
                 donc ce qu'il suffit de poser.
            ]]
            noter("    variables du blueprint d'animation :")
            local vues = 0
            pourChaquePropriete(sur(function() return anim:GetClass() end, nil), function(nom, type)
                vues = vues + 1
                noter(string.format("      %-34s (%s)", nom, type))
            end, 40)
            if vues == 0 then noter("      (aucune lisible)") end
        end
    else
        noter("  maille (Mesh)            : INTROUVABLE")
    end

    noter("")
    noter("--- 1b. Noms au-dessus des tetes : on essaie vraiment ---")

    local candidates = {
        { "TextRenderComponent", "/Script/Engine.TextRenderComponent" },
        { "WidgetComponent",     "/Script/UMG.WidgetComponent" },
        { "UserWidget",          "/Script/UMG.UserWidget" },
        { "TextBlock",           "/Script/UMG.TextBlock" },
        { "HUD",                 "/Script/Engine.HUD" },
        { "CanvasPanel",         "/Script/UMG.CanvasPanel" },
        { "WidgetBlueprintLibrary", "/Script/UMG.Default__WidgetBlueprintLibrary" },
    }
    for _, c in ipairs(candidates) do
        local trouvee = sur(function() return StaticFindObject(c[2]) end, nil)
        noter(string.format("  %-24s : %s", c[1], estValide(trouvee) and "PRESENTE" or "absente"))
    end

    --[[
      ⚠️ ON CREE VRAIMENT UNE PLAQUE, PUIS ON LA DETRUIT. Savoir que la classe
         existe ne dit pas si `StaticConstructObject` l'accepte, si
         `RegisterComponent` passe, ni par quel chemin on peut poser le texte.
         Les trois sont la vraie question, et ils ne se devinent pas.
    ]]
    local classeTexte = sur(function() return StaticFindObject("/Script/Engine.TextRenderComponent") end, nil)
    if estValide(classeTexte) then
        local essai = sur(function() return StaticConstructObject(classeTexte, pion) end, nil)
        noter("  StaticConstructObject    : " .. (estValide(essai) and "OK" or "ECHEC"))
        if estValide(essai) then
            noter("  RegisterComponent        : " .. tostring(sur(function()
                essai:RegisterComponent()
                return "OK"
            end, "ECHEC")))

            local racine = sur(function() return pion:K2_GetRootComponent() end, nil)
            noter("  K2_GetRootComponent      : " .. (estValide(racine) and nomDeClasse(racine) or "ECHEC"))
            if estValide(racine) then
                noter("  K2_AttachToComponent     : " .. tostring(sur(function()
                    essai:K2_AttachToComponent(racine, "", 0, 0, 0, false)
                    return "OK"
                end, "ECHEC")))
            end

            local chemin = "aucun"
            if sur(function() essai.Text = "Voyage" return true end, false) then chemin = ".Text"
            elseif sur(function() essai:SetText("Voyage") return true end, false) then chemin = "SetText(chaine)"
            elseif sur(function() essai:SetText({ "Voyage" }) return true end, false) then chemin = "SetText(table)"
            end
            noter("  poser le texte           : " .. chemin)
            noter("  SetWorldSize             : " .. tostring(sur(function() essai:SetWorldSize(26.0) return "OK" end, "ECHEC")))
            noter("  SetTextRenderColor       : " .. tostring(sur(function()
                essai:SetTextRenderColor({ R = 220, G = 210, B = 180, A = 255 })
                return "OK"
            end, "ECHEC")))

            -- On ne laisse rien derriere nous : la sonde ne modifie pas le jeu.
            noter("  K2_DestroyComponent      : " .. tostring(sur(function()
                essai:K2_DestroyComponent(pion)
                return "OK"
            end, "ECHEC")))
        end
    end

    -- Un HUD vivant permettrait de dessiner sans rien instancier.
    local hud = sur(function() return FindFirstOf("HUD") end, nil)
    noter("  HUD actif en jeu         : " .. (estValide(hud) and nomComplet(hud) or "aucun"))
    if estValide(hud) then noter("    heritage               : " .. hierarchie(hud)) end

    noter("")
    noter("--- 1c. Affichage de texte : quel chemin accepte nos arguments ? ---")
    if estValide(pc) then
        noter("  AddMessageBySlot         : " .. tostring(sur(function()
            pc:AddMessageBySlot("Voyage", "sonde")
            return "OK"
        end, "ECHEC")))
    end
    local ks = sur(function() return StaticFindObject("/Script/Engine.Default__KismetSystemLibrary") end, nil)
    if estValide(ks) then
        noter("  PrintString              : " .. tostring(sur(function()
            ks:PrintString(sur(function() return FindFirstOf("World") end, nil),
                "[Voyage] sonde", true, false, { R = 0.8, G = 0.8, B = 0.8, A = 1.0 }, 2.0)
            return "OK"
        end, "ECHEC")))
    end

    noter("")
    noter("--- 1d. Crochets : lesquels prennent vraiment ? ---")
    --[[
      ⚠️ ON POSE DES CROCHETS VIDES, PUIS ON DIT LESQUELS ONT PRIS.
         `RegisterHook` echoue sur une fonction `Final` + `BlueprintCallable`,
         sur un delegue, et sur une UFunction pas encore en memoire. La seule
         facon de savoir est d'essayer.

      ⚠️ LES RAPPELS NE FONT RIEN. Une sonde ne doit pas changer le comportement
         du jeu, meme pendant qu'elle mesure.
    ]]
    local aEssayer = {
        "/Script/Voyage.VoyagePlayerController:OnPlayerInteraction",
        "/Script/Voyage.VoyagePlayerController:OnPlayerInteractionReleased",
        "/Script/Voyage.VoyagePlayerController:OnInventoryAdd",
        "/Script/Voyage.VoyagePlayerController:OnInventoryRemove",
        "/Script/Voyage.VoyagePlayerController:OnPlayerDropFromInventory",
        "/Script/Voyage.VoyagePlayerController:OnPlayerInventoryItemUsed",
        "/Script/Voyage.VoyageBaseCharacter:OnSurvivalDeath",
        "/Script/Voyage.VoyageBaseCharacter:OnVisualizeDeath",
        "/Script/Voyage.VoyageBaseCharacter:OnVisualizeDamage",
        "/Script/Voyage.VoyageBaseCharacter:OnInventoryAdd",
        "/Script/Voyage.VoyageBaseCharacter:OnInventoryChanged",
        "/Script/Voyage.VoyageBaseCharacter:OnEquipmentItemEquipped",
        "/Script/Voyage.VoyageBaseCharacter:GetHealth",
        "/Script/Voyage.BP_Base_Character_C:ReceiveAnyDamage",
        "/Script/Voyage.BP_Base_Character_C:OnCustomDataSave",
        "/Script/Voyage.BP_FirstPersonCharacter_New_C:Place",
        "/Script/Voyage.BP_FirstPersonCharacter_New_C:ToggleThirdPerson",
    }
    for _, chemin in ipairs(aEssayer) do
        local ok = pcall(function() RegisterHook(chemin, function() end) end)
        noter(string.format("  %-62s %s", chemin, ok and "pose" or "REFUSE"))
    end

    noter("  NotifyOnNewObject(VoyageNPCBaseCharacter) : " .. tostring(sur(function()
        NotifyOnNewObject("/Script/Voyage.VoyageNPCBaseCharacter", function() end)
        return "OK"
    end, "ECHEC")))

    -- ══ 2. L'INVENTAIRE, LA DERNIERE GRANDE INCONNUE ══════════════════════
    --[[
      ⚠️ C'EST LE BLOC QUI MANQUAIT, ET C'EST LUI QUI BLOQUE L'INVENTAIRE
         PARTAGE. On sait que `GetInventoryComponent` existe sur le pion et sur
         le controleur ; on ne sait pas ce que le composant expose. Sans ces
         noms, un depot dans le coffre commun serait une devinette — et une
         devinette sur un appel d'UFunction fait tomber le jeu.
    ]]
    noter("")
    noter("=== INVENTAIRE ET EQUIPEMENT ===")

    local function fouillerComposant(composant, etiquette)
        if not estValide(composant) then
            noter("  " .. etiquette .. " : ABSENT")
            return
        end
        noter("  " .. etiquette .. " : " .. nomComplet(composant))
        noter("    heritage : " .. hierarchie(composant))

        noter("    fonctions :")
        local vues = 0
        pourChaqueFonction(composant, function(classe, nom, fonction)
            vues = vues + 1
            noter(string.format("      %s : %s", classe, nom))
            local sig = signature(fonction)
            if sig ~= "(aucun parametre visible)" then noter("          " .. sig) end
        end, 60)
        if vues == 0 then noter("      (aucune lisible)") end

        noter("    proprietes :")
        local vuesP = 0
        pourChaquePropriete(sur(function() return composant:GetClass() end, nil), function(nom, type)
            vuesP = vuesP + 1
            noter(string.format("      %-34s (%s)", nom, type))
        end, 40)
        if vuesP == 0 then noter("      (aucune lisible)") end
    end

    fouillerComposant(sur(function() return pion:GetInventoryComponent() end, nil), "inventaire du pion")
    if estValide(pc) then
        fouillerComposant(sur(function() return pc:GetInventoryComponent() end, nil), "inventaire du controleur")
        fouillerComposant(sur(function() return pc:GetEquipmentComponent() end, nil), "equipement du controleur")
        fouillerComposant(sur(function() return pc:GetWeaponHolsterComponent() end, nil), "holster du controleur")
    end

    -- ══ 3. LES COMPOSANTS DU PION ═════════════════════════════════════════
    noter("")
    noter("=== COMPOSANTS PORTES PAR LE PION ===")
    local composantClasse = sur(function() return StaticFindObject("/Script/Engine.ActorComponent") end, nil)
    local composants = sur(function() return pion:K2_GetComponentsByClass(composantClasse) end, nil)
    local vusC = pourChaque(composants, function(c)
        noter("  " .. sur(function() return c:GetFName():ToString() end, "?")
            .. "  <" .. nomDeClasse(c) .. ">")
    end, 40)
    if vusC == 0 then noter("  (liste indisponible par K2_GetComponentsByClass)") end

    -- ══ 4. PROPRIETES DU PION, DU CONTROLEUR, DES ETATS ═══════════════════
    noter("")
    noter("=== PROPRIETES ===")

    local function proprietesDe(objet, etiquette, plafond)
        if not estValide(objet) then
            noter("  " .. etiquette .. " : (absent)")
            return
        end
        local vues = 0
        pourChaquePropriete(sur(function() return objet:GetClass() end, nil), function(nom, type)
            vues = vues + 1
            noter(string.format("  %s %-34s (%s)", etiquette, nom, type))
        end, plafond)
        if vues == 0 then noter("  " .. etiquette .. " : (aucune propriete lisible)") end
    end

    proprietesDe(pion, "[pion]", 70)
    proprietesDe(pc, "[controleur]", 30)
    proprietesDe(sur(function() return FindFirstOf("PlayerState") end, nil), "[etat joueur]", 25)
    proprietesDe(sur(function() return FindFirstOf("GameStateBase") end, nil), "[etat partie]", 25)

    -- ══ 5. LE CIEL ET LE TEMPS ════════════════════════════════════════════
    --[[
      ⚠️ SANS CE BLOC, SYNCHRONISER L'HEURE EST UNE DEVINETTE. On sait qu'
         `Ultra_Dynamic_Sky_Voyage_C` existe ; on ne sait pas si son heure
         s'ecrit, ni sous quel nom. Les deux se lisent ici.
    ]]
    noter("")
    noter("=== CIEL, METEO, TEMPS ===")
    for _, nomClasseCiel in ipairs({
        "Ultra_Dynamic_Sky_Voyage_C", "Ultra_Dynamic_Weather_Voyage_C", "BP_PersistentWorldTime_C",
    }) do
        local a = sur(function() return FindFirstOf(nomClasseCiel) end, nil)
        if estValide(a) then
            noter("  " .. nomClasseCiel .. " : present")
            local vues = 0
            pourChaquePropriete(sur(function() return a:GetClass() end, nil), function(nom, type)
                -- On ne garde que ce qui ressemble a du temps : la liste complete
                -- d'Ultra Dynamic Sky fait des centaines d'entrees.
                local bas = nom:lower()
                if bas:find("time") or bas:find("day") or bas:find("sun") or bas:find("moon")
                    or bas:find("weather") or bas:find("cloud") or bas:find("rain")
                    or bas:find("storm") or bas:find("fog") or bas:find("season") then
                    vues = vues + 1
                    noter(string.format("    %-34s (%s)", nom, type))
                end
            end, 300)
            if vues == 0 then noter("    (aucune propriete de temps lisible)") end

            -- L'heure s'ecrit-elle ? On repose la valeur lue : rien ne change.
            local heure = sur(function() return a.TimeOfDay end, nil)
            if heure ~= nil then
                noter("    TimeOfDay (lecture)  : " .. tostring(heure))
                noter("    TimeOfDay (ecriture) : " .. tostring(sur(function()
                    a.TimeOfDay = heure
                    return "POSSIBLE"
                end, "refusee")))
            else
                noter("    TimeOfDay            : illisible")
            end
        else
            noter("  " .. nomClasseCiel .. " : absent")
        end
    end

    -- ══ 6. LES CREATURES ══════════════════════════════════════════════════
    --[[
      ⚠️ ON VEUT LA CHAINE D'HERITAGE, PAS LE COMPTE. Un compte dit « il y a deux
         requins » ; l'heritage dit a quelle classe s'accrocher pour les detecter
         tous, y compris ceux que le jeu ajoutera plus tard.
    ]]
    noter("")
    noter("=== CREATURES ===")
    local vuesCr = {}
    for _, famille in ipairs({ "Pawn", "Character", "Actor" }) do
        local liste = sur(function() return FindAllOf(famille) end, nil)
        if liste then
            local combien = sur(function() return #liste end, 0)
            for i = 1, math.min(combien, 4000) do
                local a = sur(function() return liste[i] end, nil)
                if estValide(a) then
                    local n = nomDeClasse(a)
                    if (n:find("^BP_NPC_") or n:find("^BP_Swarm") or n:find("NPC")) and not vuesCr[n] then
                        vuesCr[n] = true
                        noter("  " .. n)
                        noter("    heritage : " .. hierarchie(a))
                        local vie = sur(function() return a:GetHealth() end, nil)
                        if vie == nil then vie = sur(function() return a.Health end, nil) end
                        noter("    vie      : " .. tostring(vie or "illisible"))
                    end
                end
            end
        end
        -- Les pions suffisent s'ils ont deja donne quelque chose.
        if famille == "Character" and next(vuesCr) ~= nil then break end
    end
    if next(vuesCr) == nil then noter("  (aucune creature trouvee — essaie en mer ou de nuit)") end

    noter("  classe de base VoyageNPCBaseCharacter : " .. tostring(sur(function()
        return estValide(StaticFindObject("/Script/Voyage.VoyageNPCBaseCharacter")) and "PRESENTE" or "absente"
    end, "absente")))

    -- ══ 7. CE QU'ON PEUT ACTIONNER ════════════════════════════════════════
    --[[
      ⚠️ CE BLOC DECIDE DE LA REPLICATION DES PORTES ET DES MACHINES. On a les
         noms (`BP_Door_Light_C`, `BP_Module_Generic_Switch_C`) ; il manque
         l'heritage, les proprietes d'etat (ouvert, alimente) et les fonctions a
         accrocher.
    ]]
    noter("")
    noter("=== PORTES, INTERRUPTEURS, CONTENEURS ===")
    for _, cible in ipairs({
        "BP_Door_Light_C", "BP_PowerDoor_Single_Interior_C", "BP_Boat_Door_C",
        "BP_Module_Generic_Switch_C", "BP_Module_LightSwitch_C",
        "BP_Inventory_Container_Fishing_C", "BP_Module_Diesel_Container_C",
    }) do
        local a = sur(function() return FindFirstOf(cible) end, nil)
        if estValide(a) then
            noter("  " .. cible)
            noter("    heritage : " .. hierarchie(a))
            local vues = 0
            pourChaquePropriete(sur(function() return a:GetClass() end, nil), function(nom, type)
                local bas = nom:lower()
                if bas:find("open") or bas:find("close") or bas:find("state") or bas:find("power")
                    or bas:find("lock") or bas:find("active") or bas:find("inventory") then
                    vues = vues + 1
                    noter(string.format("    %-32s (%s)", nom, type))
                end
            end, 120)
            if vues == 0 then noter("    (aucune propriete d'etat reperee)") end

            local f = 0
            pourChaqueFonction(a, function(classe, nom)
                local bas = nom:lower()
                if bas:find("open") or bas:find("close") or bas:find("toggle") or bas:find("interact")
                    or bas:find("use") or bas:find("power") or bas:find("activate") then
                    f = f + 1
                    noter("    fonction : " .. classe .. " : " .. nom)
                end
            end, 200)
            if f == 0 then noter("    (aucune fonction d'action reperee)") end
        else
            noter("  " .. cible .. " : absent de cette zone")
        end
    end

    -- ══ 8. RECENSEMENT DU MONDE ═══════════════════════════════════════════
    --[[
      ⚠️ UN SEUL PARCOURS DES ACTEURS, ET DES COMPTES PAR CLASSE. Un monde
         charge en contient des milliers ; les lister un par un donnerait un
         fichier illisible et ferait ramer le jeu.
    ]]
    noter("")
    noter("=== RECENSEMENT DU MONDE ===")

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

    local comptes, exemples, census = {}, {}, {}
    local tousLesActeurs = sur(function() return FindAllOf("Actor") end, {}) or {}
    local total = sur(function() return #tousLesActeurs end, 0)
    noter("  acteurs parcourus : " .. tostring(total))

    for i = 1, total do
        local a = sur(function() return tousLesActeurs[i] end, nil)
        local nomC = a and sur(function() return a:GetClass():GetFName():ToString() end, nil) or nil
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
            local ex = lignesF[1][3]
            if ex then
                noter("    exemple : " .. hierarchie(ex))
                noter("    position: " .. vecteur(sur(function() return ex:K2_GetActorLocation() end, nil)))
            end
        end
    end

    noter("")
    noter("  [LES PLUS NOMBREUSES, tous noms confondus]")
    local tri = {}
    for nomC, combien in pairs(census) do tri[#tri + 1] = { nomC, combien } end
    table.sort(tri, function(x, y) return x[2] > y[2] end)
    for k = 1, math.min(#tri, 25) do
        noter(string.format("    %-46s x%d", tri[k][1], tri[k][2]))
    end

    -- ══ 9. SAUVEGARDE ET SESSION ══════════════════════════════════════════
    noter("")
    noter("=== SAUVEGARDE ET SESSION ===")

    local voulues = {
        "TravelToWorldWithSaveGame", "TravelToWorldWithGameProgess", "InitFreshNewGameProgress",
        "LoadGameFromSlot", "SaveGameToSlot", "DoesSaveGameExist", "CreateSaveGameObject",
        "AddMessageBySlot", "GetInventoryComponent", "GetEquipmentComponent", "GetHealth",
    }
    local recherchees = {}
    for _, v in ipairs(voulues) do recherchees[v] = true end

    local function chercherDans(objet, etiquette)
        if not estValide(objet) then return end
        pourChaqueFonction(objet, function(classe, nom, fonction)
            if recherchees[nom] then
                noter("  " .. etiquette .. " " .. classe .. " : " .. nom)
                noter("      " .. signature(fonction))
            end
        end, 600)
    end

    chercherDans(sur(function() return FindFirstOf("GameInstance") end, nil), "[instance]")
    chercherDans(sur(function() return StaticFindObject("/Script/Engine.Default__GameplayStatics") end, nil), "[statics]")
    chercherDans(pc, "[controleur]")
    chercherDans(pion, "[pion]")

    noter("")
    noter("instance de jeu : " .. nomComplet(sur(function() return FindFirstOf("GameInstance") end, nil)))

    local ldd = os.getenv("LOCALAPPDATA")
    noter("dossier de sauvegardes attendu : " .. (ldd and (ldd .. "\\Voyage\\Saved\\SaveGames") or "(LOCALAPPDATA inconnu)"))

    noter("")
    noter("--- Points d'accroche connus ---")
    for _, c in ipairs({
        "/Script/Voyage.VoyageDoorActor",
        "/Script/Voyage.VoyageModuleActor",
        "/Script/Voyage.VoyageModuleGenericSwitchActor",
        "/Script/Voyage.VoyageNPCBaseCharacter",
        "/Script/Voyage.VoyageBaseCharacter",
        "/Script/Voyage.VoyageCharacterMovementComponent",
    }) do
        local o = sur(function() return StaticFindObject(c) end, nil)
        noter(string.format("  %-54s %s", c, estValide(o) and "PRESENT" or "absent"))
    end

    noter("")
    noter("=== FIN ===")
    ecrireRapport()
end

-- Premier essai 10 s apres le chargement, puis toutes les 15 s.
ExecuteWithDelay(10000, function() pcall(sonder) end)

--[[
  F8 reste disponible pour forcer, mais plus rien n'en depend.

  ⚠️ `RegisterKeyBind` SE DECLENCHE SUR UN FIL QUI N'EST PAS CELUI DU JEU, et
     `sonder()` parcourt des milliers d'objets Unreal. Lance directement depuis
     ce fil, il fait tomber le jeu. On repasse donc par `ExecuteInGameThread`.
]]
pcall(function()
    RegisterKeyBind(Key.F8, function()
        ExecuteInGameThread(function()
            fini = false
            essais = 0
            pcall(sonder)
        end)
    end)
end)

print("[" .. NOM .. "] chargee. Elle cherchera toute seule des qu'une partie sera ouverte.\n")
