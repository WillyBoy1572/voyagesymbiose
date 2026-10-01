--[[
═══════════════════════════════════════════════════════════════════════════
  VOYAGE — SONDE MAX
═══════════════════════════════════════════════════════════════════════════
  A poser dans :  <Jeu>\Binaries\Win64\ue4ss\Mods\VoyageSondeMax\Scripts\main.lua
  Rapport ecrit a cote de l'executable : VoyageSondeMax.txt

  ⚠️ CELLE-CI N'EST PAS DISTRIBUEE. Elle accroche une vingtaine de fonctions du
     jeu pour ENREGISTRER ce qu'elles recoivent. C'est exactement ce qu'il faut
     pour comprendre la construction et l'inventaire, et exactement ce qu'on ne
     met pas dans un installeur public : elle ecrit en continu, elle est bavarde,
     et elle n'a d'interet que pour celui qui lit le fichier.

  CE QU'ELLE AJOUTE A `VoyageSonde` (qui, elle, est livree) :

    1. LES DRAPEAUX DE REPLICATION. Le jeu marque lui-meme ce qu'il voudrait
       synchroniser : une propriete `CPF_Net`, une fonction `NetMulticast`. Ce
       sont les intentions des developpeurs, ecrites dans le binaire. C'est
       l'information la plus utile du fichier et personne ne la regardait.

    2. LES ARGUMENTS DES CROCHETS, EN VRAI. L'ancienne sonde posait des crochets
       VIDES pour voir lesquels prennent. Celle-ci note ce qui passe dedans :
       quand tu poses un panneau solaire, elle ecrit la classe exacte, la
       position, le parent. C'est la reponse a la question qui bloque.

    3. LE CONTENU DE L'INVENTAIRE, PAS SA FORME. On essaie tous les getters
       plausibles, et si l'un rend une liste, on la parcourt objet par objet.

    4. L'OBJET DE SAUVEGARDE. Ce que le jeu persiste est la meilleure carte de
       ce qui compte vraiment dans son monde.

  ⚠️ ELLE NE CHANGE RIEN AU JEU. Chaque crochet note et rend la main. Aucun
     appel qui modifie l'etat n'est tente sans etre defait tout de suite apres,
     et ceux-la sont marques « ESSAI ECRITURE » dans le rapport.

  ⚠️ TOUT EST PLAFONNE. Un crochet sur une fonction appelee a chaque image
     remplirait le disque en deux minutes. Chaque crochet a son propre compteur,
     et il se tait quand il a assez parle.

  ⚠️ TOUT EST EN pcall. Une erreur Lua dans un mod UE4SS peut figer le jeu au
     chargement : ici le pire est une ligne « echec » dans le fichier.
═══════════════════════════════════════════════════════════════════════════
]]

local NOM = "VoyageSondeMax"
local FICHIER = NOM .. ".txt"

--- Combien de fois chaque crochet a le droit de parler. Au-dela, il se tait.
local PRISES_PAR_CROCHET = 12

--- Plafonds de parcours : une classe du moteur a des centaines de membres.
local MAX_FONCTIONS = 400
local MAX_PROPRIETES = 400
local MAX_ACTEURS = 60

local ESSAIS_MAX = 240          -- 240 x 15 s = une heure pour charger une partie
local INTERVALLE_MS = 15000

local essais = 0
local pret = false
local lignes = {}
local prises = {}

-- ═══════════════════════════════════════════════════════════════════════════
--  Outils
-- ═══════════════════════════════════════════════════════════════════════════

local function sur(f, repli)
    local ok, r = pcall(f)
    if ok and r ~= nil then return r end
    return repli
end

local function ecrire()
    local f = io.open(FICHIER, "w")
    if not f then return false end
    f:write(table.concat(lignes, "\n"))
    f:write("\n")
    f:close()
    return true
end

--[[
  ATTENTION : ON ECRIT SOUVENT, MAIS PAS A CHAQUE LIGNE. Un crochet peut se
     declencher une heure apres le demarrage et le jeu peut planter entre-temps :
     un rapport qu on n ecrit qu a la fin est un rapport qu on perd.

     Mais le balayage complet du jeu produit des dizaines de milliers de lignes.
     Reecrire le fichier entier a chaque ligne, c est des centaines de millions
     d octets ecrits sur le disque et un jeu fige pendant des minutes. On ecrit
     donc tous les PAS_ECRITURE, et toujours aux moments qui comptent.

  ATTENTION : ON N AFFICHE PAS TOUT DANS LA CONSOLE DU JEU. `print` sur chaque
     ligne d un balayage complet, c est le meme probleme en pire : la console
     d UE4SS n est pas faite pour ca.
]]
local PAS_ECRITURE = 500
local depuisEcriture = 0

local function noter(texte, discret)
    lignes[#lignes + 1] = texte
    if not discret then print("[" .. NOM .. "] " .. tostring(texte) .. "\n") end
    depuisEcriture = depuisEcriture + 1
    if depuisEcriture >= PAS_ECRITURE then
        depuisEcriture = 0
        pcall(ecrire)
    end
end

--- Une ligne de balayage : elle va dans le fichier, pas dans la console.
local function noterDiscret(texte)
    noter(texte, true)
end

--- Pose le fichier sur le disque maintenant, quoi qu il arrive.
local function poser()
    depuisEcriture = 0
    pcall(ecrire)
end

local function titre(texte)
    noter("")
    noter("=== " .. texte .. " " .. string.rep("=", math.max(2, 68 - #texte)))
    poser()
end

local function sousTitre(texte)
    noter("")
    noter("--- " .. texte .. " ---")
end

local function estValide(o)
    return o ~= nil and sur(function() return o:IsValid() end, false)
end

local function nomComplet(o)
    if not estValide(o) then return "(invalide)" end
    return sur(function() return o:GetFullName() end, "(sans nom)")
end

local function nomDeClasse(o)
    if not estValide(o) then return "(invalide)" end
    return sur(function() return o:GetClass():GetFName():ToString() end, "?")
end

local function nomCourt(o)
    if not estValide(o) then return "(invalide)" end
    return sur(function() return o:GetFName():ToString() end, "?")
end

local function hierarchie(o)
    if not estValide(o) then return "(invalide)" end
    local bouts = {}
    sur(function()
        local c = o:GetClass()
        while estValide(c) and #bouts < 12 do
            bouts[#bouts + 1] = c:GetFName():ToString()
            c = c:GetSuperStruct()
        end
        return true
    end, nil)
    return #bouts > 0 and table.concat(bouts, " < ") or "(illisible)"
end

local function vecteur(v)
    if v == nil then return "nil" end
    local x = sur(function() return v.X end, nil)
    if x == nil then return tostring(v) end
    return string.format("(%.1f, %.1f, %.1f)",
        x, sur(function() return v.Y end, 0), sur(function() return v.Z end, 0))
end

--[[
  Decrit une valeur quelconque venue du jeu, sans jamais planter dessus.

  ⚠️ UN ARGUMENT DE CROCHET PEUT ETRE N'IMPORTE QUOI : un nombre, un objet, une
     structure, un pointeur mort. On essaie de le decrire de la facon la plus
     informative possible et on retombe sur son type.
]]
local function decrire(v, profondeur)
    profondeur = profondeur or 0
    if v == nil then return "nil" end
    local t = type(v)
    if t == "number" or t == "boolean" or t == "string" then return tostring(v) end

    -- Une structure vecteur ?
    local x = sur(function() return v.X end, nil)
    if x ~= nil then return "Vector" .. vecteur(v) end

    -- Un objet du jeu ?
    if sur(function() return v:IsValid() end, false) then
        local bout = nomCourt(v) .. " <" .. nomDeClasse(v) .. ">"
        if profondeur < 1 then
            -- Une position, si c'est un acteur : c'est souvent ce qu'on cherche.
            local pos = sur(function() return v:K2_GetActorLocation() end, nil)
            if pos then bout = bout .. " @ " .. vecteur(pos) end
            local parent = sur(function() return v:GetAttachParentActor() end, nil)
            if estValide(parent) then
                bout = bout .. " attache a " .. nomCourt(parent) .. " <" .. nomDeClasse(parent) .. ">"
            end
        end
        return bout
    end

    -- Un FName ?
    local s = sur(function() return v:ToString() end, nil)
    if s then return "FName:" .. tostring(s) end

    return "(" .. t .. ")"
end

-- ═══════════════════════════════════════════════════════════════════════════
--  Les drapeaux : ce que le jeu DIT vouloir synchroniser
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ C'EST LE BLOC QUI VAUT LE PLUS CHER. Unreal marque dans le binaire les
     proprietes repliquees (`CPF_Net`) et les fonctions reseau (`NetMulticast`,
     `NetServer`...). Ce sont les intentions des developpeurs, pas nos
     suppositions : tout ce qui porte ces drapeaux est quelque chose que le jeu
     lui-meme considere comme devant traverser le reseau.

  ⚠️ ON IMPRIME AUSSI LE NOMBRE BRUT. Si la table de drapeaux a change entre
     deux versions d'Unreal, mon decodage sera faux et le nombre, lui, restera
     juste. Autant le garder.
]]
local DRAPEAUX_FONCTION = {
    { 0x00000001, "Final" },
    { 0x00000020, "Exec" },
    { 0x00000040, "Net" },
    { 0x00000080, "NetReliable" },
    { 0x00000100, "NetRequest" },
    { 0x00000200, "Exec_Native" },
    { 0x00000400, "Event" },
    { 0x00000800, "NetResponse" },
    { 0x00004000, "NetMulticast" },
    { 0x00040000, "Delegate" },
    { 0x00200000, "NetServer" },
    { 0x01000000, "NetClient" },
    { 0x04000000, "BlueprintCallable" },
    { 0x08000000, "BlueprintEvent" },
    { 0x40000000, "BlueprintPure" },
}

local DRAPEAUX_PROPRIETE = {
    { 0x0000000000000004, "BlueprintVisible" },
    { 0x0000000000000010, "BlueprintReadOnly" },
    { 0x0000000000000020, "Net" },
    { 0x0000000000002000, "Transient" },
    { 0x0000000000080000, "InstancedReference" },
    { 0x0000000001000000, "SaveGame" },
    { 0x0000000008000000, "RepSkip" },
    { 0x0000000010000000, "RepNotify" },
}

local function decoder(valeur, table_)
    if type(valeur) ~= "number" then return nil end
    local entier = math.floor(valeur)
    local mots = {}
    for _, paire in ipairs(table_) do
        if (entier & paire[1]) ~= 0 then mots[#mots + 1] = paire[2] end
    end
    return #mots > 0 and table.concat(mots, "|") or "-"
end

local function drapeauxDeFonction(f)
    local brut = sur(function() return f:GetFunctionFlags() end, nil)
    if brut == nil then return "" end
    local lisible = decoder(brut, DRAPEAUX_FONCTION) or "?"
    return string.format("  [0x%X %s]", math.floor(brut), lisible)
end

local function drapeauxDePropriete(p)
    local brut = sur(function() return p:GetPropertyFlags() end, nil)
    if brut == nil then return "" end
    local lisible = decoder(brut, DRAPEAUX_PROPRIETE) or "?"
    return string.format("  [0x%X %s]", math.floor(brut), lisible)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  Parcours
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ LES PROPRIETES D'UNE CLASSE UE5 SONT DES `FField`, PAS DES `UProperty`. Un
     parcours par `ChildProperties` ne rend RIEN et on croit que la classe est
     vide. Il faut `ForEachProperty`, et ce detail a deja coute une soiree.
]]
local function pourChaquePropriete(structure, rappel, plafond)
    if not estValide(structure) then return 0 end
    local vus = 0
    sur(function()
        local s = structure
        while estValide(s) and vus < (plafond or MAX_PROPRIETES) do
            local nomStruct = sur(function() return s:GetFName():ToString() end, "?")
            sur(function()
                s:ForEachProperty(function(p)
                    if vus >= (plafond or MAX_PROPRIETES) then return end
                    vus = vus + 1
                    rappel(
                        nomStruct,
                        sur(function() return p:GetFName():ToString() end, "?"),
                        sur(function() return p:GetClass():GetFName():ToString() end, "?"),
                        drapeauxDePropriete(p)
                    )
                end)
                return true
            end, nil)
            s = sur(function() return s:GetSuperStruct() end, nil)
        end
        return true
    end, nil)
    return vus
end

local function pourChaqueFonction(objet, rappel, plafond)
    if not estValide(objet) then return 0 end
    local vus = 0
    sur(function()
        local c = objet:GetClass()
        while estValide(c) and vus < (plafond or MAX_FONCTIONS) do
            local nomClasse = sur(function() return c:GetFName():ToString() end, "?")
            sur(function()
                c:ForEachFunction(function(f)
                    if vus >= (plafond or MAX_FONCTIONS) then return end
                    vus = vus + 1
                    rappel(nomClasse, sur(function() return f:GetFName():ToString() end, "?"), f)
                end)
                return true
            end, nil)
            c = sur(function() return c:GetSuperStruct() end, nil)
        end
        return true
    end, nil)
    return vus
end

local function pourChaque(tableau, rappel, plafond)
    if tableau == nil then return 0 end
    local n = sur(function() return #tableau end, 0)
    local vus = 0
    for i = 1, math.min(n, plafond or MAX_ACTEURS) do
        -- ⚠️ UN ELEMENT DE TArray EST UNE ENVELOPPE : sans `:get()`, on decrit l'enveloppe.
        local e = sur(function() return tableau[i]:get() end, nil) or sur(function() return tableau[i] end, nil)
        if e ~= nil then
            vus = vus + 1
            sur(function() rappel(e, i) return true end, nil)
        end
    end
    return vus
end

-- ═══════════════════════════════════════════════════════════════════════════
--  Les crochets qui ENREGISTRENT
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ C'EST LA RAISON D'ETRE DE CE FICHIER. Savoir qu'un crochet « prend » ne
     sert a rien ; savoir CE QU'IL RECOIT repond a la question. Quand tu poses
     un panneau solaire, c'est ici qu'on apprend la classe exacte, la position
     et le parent — les trois choses qui manquent pour le reconstruire chez
     l'autre joueur.

  ⚠️ LE RAPPEL NE TOUCHE A RIEN ET NE REND RIEN. Un crochet qui modifie un
     argument change le jeu ; un crochet qui plante le fige. On note, on sort.
]]
local function accrocher(chemin, etiquette)
    local ok = pcall(function()
        RegisterHook(chemin, function(...)
            --[[
              ⚠️ ON RAMASSE LES ARGUMENTS ICI, PAS DANS LE pcall. Lua refuse `...`
                 dans une fonction qui n'est pas elle-meme variadique : le fichier
                 ne se chargeait pas du tout, et un mod qui ne charge pas fige le
                 jeu au demarrage. Le verificateur de syntaxe l'a attrape avant
                 qu'il arrive dans le jeu.

              ⚠️ `select('#', ...)` ET PAS `#args` : un argument nil au milieu
                 tronquerait la liste, et c'est precisement sur un argument absent
                 qu'on veut savoir.
            ]]
            local args = { ... }
            local combien = select('#', ...)
            pcall(function()
                prises[chemin] = (prises[chemin] or 0) + 1
                if prises[chemin] > PRISES_PAR_CROCHET then return end

                local bouts = {}
                for i = 1, combien do
                    -- Le premier argument est le `self` du contexte : utile une fois.
                    bouts[#bouts + 1] = string.format("arg%d=%s", i, decrire(args[i], i == 1 and 1 or 0))
                end
                noter(string.format("  [PRISE %d/%d] %s  %s",
                    prises[chemin], PRISES_PAR_CROCHET, etiquette,
                    #bouts > 0 and table.concat(bouts, "  ") or "(aucun argument)"))

                if prises[chemin] == PRISES_PAR_CROCHET then
                    noter("  (" .. etiquette .. " : assez parle, il se taira maintenant)")
                end
                -- Une prise est rare et precieuse : elle va sur le disque maintenant.
                poser()
            end)
        end)
    end)
    noter(string.format("  %-66s %s", chemin, ok and "accroche" or "REFUSE"))
    return ok
end

-- ═══════════════════════════════════════════════════════════════════════════
--  Trouver le joueur
-- ═══════════════════════════════════════════════════════════════════════════

local function trouverPion()
    local p = sur(function() return UEHelpers.GetPlayer() end, nil)
    if estValide(p) then return p end
    local pc = sur(function() return UEHelpers.GetPlayerController() end, nil)
    if estValide(pc) then
        p = sur(function() return pc.Pawn end, nil)
        if estValide(p) then return p end
    end
    for _, classe in ipairs({
        "BP_FirstPersonCharacter_New_C", "BP_Base_Character_C", "VoyageBaseCharacter",
    }) do
        local trouves = sur(function() return FindAllOf(classe) end, nil)
        local resultat = nil
        pourChaque(trouves, function(o)
            if resultat == nil and estValide(o) then resultat = o end
        end, 5)
        if resultat then return resultat end
    end
    return nil
end

--[[
  ⚠️ ELLE IGNORE LE MENU. Le jeu tourne deja au menu, avec un pion a (0,0,0)
     dans une carte vide : une sonde qui s'en contente rend un rapport qui a
     l'air complet et ne decrit rien.
]]
local function enPartie(pion)
    if not estValide(pion) then return false end
    local monde = sur(function() return pion:GetWorld():GetFName():ToString() end, "")
    if monde == "" or monde:lower():find("empty") or monde:lower():find("menu") then return false end
    local pos = sur(function() return pion:K2_GetActorLocation() end, nil)
    if pos == nil then return false end
    local x = sur(function() return pos.X end, 0)
    local y = sur(function() return pos.Y end, 0)
    local z = sur(function() return pos.Z end, 0)
    return math.abs(x) + math.abs(y) + math.abs(z) > 1.0
end

-- ═══════════════════════════════════════════════════════════════════════════
--  1. L'INVENTAIRE : SON CONTENU, PAS SA FORME
-- ═══════════════════════════════════════════════════════════════════════════

local function fouillerListe(liste, etiquette)
    if liste == nil then return 0 end
    local n = sur(function() return #liste end, nil)
    if n == nil then
        noter("      " .. etiquette .. " : pas une liste (" .. decrire(liste) .. ")")
        return 0
    end
    noter("      " .. etiquette .. " : " .. n .. " element(s)")
    local vus = pourChaque(liste, function(e, i)
        noter("        [" .. i .. "] " .. decrire(e, 1))
        --[[
          ⚠️ C'EST ICI QUE SE JOUE L'INVENTAIRE PARTAGE. Si un element porte un
             nom d'objet et une quantite, on peut les transmettre. S'il ne porte
             qu'un pointeur vers un asset, il faudra son chemin complet.
        ]]
        local champs = 0
        pourChaquePropriete(sur(function() return e:GetClass() end, nil), function(st, nomP, typeP, dra)
            champs = champs + 1
            local valeur = sur(function() return e[nomP] end, nil)
            noter(string.format("            %-28s %-18s = %s%s",
                nomP, typeP, decrire(valeur, 1), dra))
        end, 24)
        if champs == 0 then
            -- Une structure plate : on tente les noms les plus courants.
            for _, nomP in ipairs({
                "Item", "ItemData", "ItemClass", "ItemID", "ItemName", "Name", "Id",
                "Quantity", "Amount", "Count", "Stack", "StackSize", "Durability",
                "Slot", "SlotIndex", "Index", "Tag", "RowName", "Asset",
            }) do
                local v = sur(function() return e[nomP] end, nil)
                if v ~= nil then noter("            " .. nomP .. " = " .. decrire(v, 1)) end
            end
        end
    end, 20)
    return vus
end

local function fouillerInventaire(composant, etiquette)
    if not estValide(composant) then
        noter("  " .. etiquette .. " : ABSENT")
        return
    end
    noter("  " .. etiquette .. " : " .. nomComplet(composant))
    noter("    heritage : " .. hierarchie(composant))

    --[[
      ⚠️ ON APPELLE, ON NE SUPPOSE PAS. Une fonction qui existe dans la liste ne
         dit pas qu'elle rend quelque chose d'utilisable : seul l'appel le dit.
         On essaie donc tous les noms plausibles, et on parcourt ce qui revient.
    ]]
    sousTitre(etiquette .. " : on essaie de LIRE le contenu")
    for _, nomF in ipairs({
        "GetItems", "GetAllItems", "GetInventoryItems", "GetInventory", "GetSlots",
        "GetAllSlots", "GetContents", "GetItemList", "GetStacks", "GetEquippedItems",
        "GetItemsArray", "K2_GetItems", "GetCurrentItems", "GetStoredItems",
    }) do
        local r = sur(function() return composant[nomF](composant) end, nil)
        if r ~= nil then
            noter("    " .. nomF .. "() a repondu")
            fouillerListe(r, nomF .. "()")
        end
    end

    -- Et les proprietes qui RESSEMBLENT a une liste d'objets.
    sousTitre(etiquette .. " : proprietes qui ressemblent a un contenu")
    pourChaquePropriete(sur(function() return composant:GetClass() end, nil), function(st, nomP, typeP, dra)
        local bas = nomP:lower()
        if bas:find("item") or bas:find("slot") or bas:find("content")
            or bas:find("stack") or bas:find("inventor") or bas:find("equip") then
            local v = sur(function() return composant[nomP] end, nil)
            noter(string.format("    %-30s %-16s%s", nomP, typeP, dra))
            if v ~= nil then fouillerListe(v, nomP) end
        end
    end, MAX_PROPRIETES)

    -- Toutes les fonctions, avec leurs drapeaux reseau.
    sousTitre(etiquette .. " : fonctions et drapeaux")
    local vus = pourChaqueFonction(composant, function(classe, nomF, f)
        noter(string.format("    %-34s %-40s%s", classe, nomF, drapeauxDeFonction(f)))
    end, MAX_FONCTIONS)
    if vus == 0 then noter("    (aucune lisible)") end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  2. LA CONSTRUCTION : CE QU'UNE PIECE POSEE PORTE VRAIMENT
-- ═══════════════════════════════════════════════════════════════════════════

local function fouillerConstruction(acteur, etiquette)
    noter("  " .. etiquette .. " : " .. nomComplet(acteur))
    noter("    heritage : " .. hierarchie(acteur))
    noter("    position : " .. vecteur(sur(function() return acteur:K2_GetActorLocation() end, nil)))
    noter("    rotation : " .. vecteur(sur(function() return acteur:K2_GetActorRotation() end, nil)))

    --[[
      ⚠️ LES TROIS CHOSES QUI MANQUENT POUR RECONSTRUIRE : la classe exacte, la
         position de grille, et le module parent. On les cherche par tous les
         chemins qu'on connait, et on ecrit ce qu'on trouve.
    ]]
    local parent = sur(function() return acteur:GetAttachParentActor() end, nil)
    noter("    parent attache  : " .. (estValide(parent)
        and (nomCourt(parent) .. " <" .. nomDeClasse(parent) .. ">") or "(aucun)"))
    noter("    socket attache  : " .. tostring(sur(function()
        return acteur:GetAttachParentSocketName():ToString() end, "(aucun)")))

    --[[
      ⚠️ LES DRAPEAUX DE REPLICATION DE L'ACTEUR DISENT CE QUE LE MOTEUR FERAIT
         TOUT SEUL s'il y avait un vrai pilote reseau. Un acteur `bReplicates`
         est un acteur que les developpeurs ont prepare pour le multijoueur.
    ]]
    for _, nomP in ipairs({
        "bReplicates", "bAlwaysRelevant", "bNetLoadOnClient", "bReplicateMovement",
        "NetUpdateFrequency", "NetCullDistanceSquared", "NetPriority", "bOnlyRelevantToOwner",
    }) do
        local v = sur(function() return acteur[nomP] end, nil)
        if v ~= nil then noter("    " .. nomP .. " = " .. tostring(v)) end
    end

    sousTitre(etiquette .. " : toutes les proprietes et leurs drapeaux")
    local vusP = pourChaquePropriete(sur(function() return acteur:GetClass() end, nil),
        function(st, nomP, typeP, dra)
            local v = sur(function() return acteur[nomP] end, nil)
            noter(string.format("    %-22s %-28s %-16s = %s%s",
                st, nomP, typeP, decrire(v, 1), dra))
        end, MAX_PROPRIETES)
    if vusP == 0 then noter("    (aucune lisible)") end

    sousTitre(etiquette .. " : composants portes")
    local classeComposant = sur(function() return StaticFindObject("/Script/Engine.ActorComponent") end, nil)
    local composants = sur(function() return acteur:K2_GetComponentsByClass(classeComposant) end, nil)
    local vusC = pourChaque(composants, function(c)
        noter("    " .. nomCourt(c) .. "  <" .. nomDeClasse(c) .. ">")
    end, 30)
    if vusC == 0 then noter("    (liste indisponible)") end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  La sonde
-- ═══════════════════════════════════════════════════════════════════════════

local function sonder()
    local pion = trouverPion()
    if not enPartie(pion) then return false end

    lignes = {}
    noter("=== " .. NOM .. " ===")
    noter("Charge une partie, joue un peu, pose un objet, prends et depose des")
    noter("choses dans un coffre : les crochets ecrivent au fur et a mesure.")
    noter("Ce fichier est reecrit a chaque ligne ; il reste lisible meme si le")
    noter("jeu plante apres.")
    noter("")
    noter("pion   : " .. nomComplet(pion))
    noter("classe : " .. hierarchie(pion))
    noter("monde  : " .. sur(function() return pion:GetWorld():GetFName():ToString() end, "?"))
    noter("position : " .. vecteur(sur(function() return pion:K2_GetActorLocation() end, nil)))

    local pc = sur(function() return UEHelpers.GetPlayerController() end, nil)

    -- ══ 1. Les crochets qui enregistrent ══════════════════════════════════
    titre("CROCHETS QUI ENREGISTRENT CE QU'ILS RECOIVENT")
    noter("Chaque crochet parle au plus " .. PRISES_PAR_CROCHET .. " fois, puis se tait.")
    noter("")

    sousTitre("Construction : LE blocage numero un")
    accrocher("/Script/Voyage.BP_FirstPersonCharacter_New_C:Place", "POSE")
    for _, c in ipairs({
        "/Script/Voyage.VoyagePlayerController:OnPlayerPlaceObject",
        "/Script/Voyage.VoyagePlayerController:OnPlaceObject",
        "/Script/Voyage.VoyagePlayerController:OnBuildPlaced",
        "/Script/Voyage.VoyageBaseCharacter:OnPlace",
        "/Script/Voyage.VoyageBuildingComponent:PlaceBuilding",
        "/Script/Voyage.VoyageBuildComponent:Place",
        "/Script/Voyage.VoyageModuleComponent:AttachModule",
    }) do
        accrocher(c, "CONSTRUCTION " .. c:match("[^:]+$"))
    end

    sousTitre("Inventaire : LE blocage numero deux")
    for _, c in ipairs({
        "/Script/Voyage.VoyagePlayerController:OnInventoryAdd",
        "/Script/Voyage.VoyagePlayerController:OnInventoryRemove",
        "/Script/Voyage.VoyagePlayerController:OnPlayerDropFromInventory",
        "/Script/Voyage.VoyagePlayerController:OnPlayerInventoryItemUsed",
        "/Script/Voyage.VoyageBaseCharacter:OnInventoryAdd",
        "/Script/Voyage.VoyageBaseCharacter:OnInventoryChanged",
        "/Script/Voyage.VoyageBaseCharacter:OnEquipmentItemEquipped",
        "/Script/Voyage.VoyageInventoryComponent:AddItem",
        "/Script/Voyage.VoyageInventoryComponent:RemoveItem",
        "/Script/Voyage.VoyageInventoryComponent:OnItemAdded",
        "/Script/Voyage.VoyageInventoryComponent:OnInventoryUpdated",
    }) do
        accrocher(c, "INVENTAIRE " .. c:match("[^:]+$"))
    end

    sousTitre("Interactions, portes, machines")
    for _, c in ipairs({
        "/Script/Voyage.VoyagePlayerController:OnPlayerInteraction",
        "/Script/Voyage.VoyagePlayerController:OnPlayerInteractionReleased",
        "/Script/Voyage.VoyageInteractableComponent:Interact",
        "/Script/Voyage.VoyageDoorComponent:Toggle",
    }) do
        accrocher(c, "INTERACTION " .. c:match("[^:]+$"))
    end

    sousTitre("Degats, mort, etat du personnage")
    for _, c in ipairs({
        "/Script/Voyage.BP_Base_Character_C:ReceiveAnyDamage",
        "/Script/Voyage.VoyageBaseCharacter:OnSurvivalDeath",
        "/Script/Voyage.VoyageBaseCharacter:OnVisualizeDamage",
        "/Script/Voyage.BP_Base_Character_C:OnCustomDataSave",
    }) do
        accrocher(c, "ETAT " .. c:match("[^:]+$"))
    end

    -- ══ 2. L'inventaire ═══════════════════════════════════════════════════
    titre("INVENTAIRE : LE CONTENU")
    fouillerInventaire(sur(function() return pion:GetInventoryComponent() end, nil), "inventaire du pion")
    if estValide(pc) then
        fouillerInventaire(sur(function() return pc:GetInventoryComponent() end, nil), "inventaire du controleur")
        fouillerInventaire(sur(function() return pc:GetEquipmentComponent() end, nil), "equipement du controleur")
    end

    -- ══ 3. Tout ce qui est repliqué sur le pion et le contrôleur ══════════
    titre("CE QUE LE JEU LUI-MEME VEUT SYNCHRONISER")
    noter("Les proprietes marquees `Net` et les fonctions `NetMulticast` /")
    noter("`NetServer` / `NetClient` sont les intentions des developpeurs,")
    noter("ecrites dans le binaire. Tout ce qui est marque ici est quelque chose")
    noter("que le jeu considere comme devant traverser le reseau.")

    for etiquette, objet in pairs({ ["pion"] = pion, ["controleur"] = pc }) do
        if estValide(objet) then
            sousTitre(etiquette .. " : proprietes `Net` seulement")
            local n = 0
            pourChaquePropriete(sur(function() return objet:GetClass() end, nil),
                function(st, nomP, typeP, dra)
                    if dra:find("Net") or dra:find("RepNotify") then
                        n = n + 1
                        noter(string.format("    %-22s %-28s %-16s%s", st, nomP, typeP, dra))
                    end
                end, MAX_PROPRIETES)
            if n == 0 then noter("    (aucune : le jeu ne marque rien comme repliquee ici)") end

            sousTitre(etiquette .. " : fonctions reseau seulement")
            local nf = 0
            pourChaqueFonction(objet, function(classe, nomF, f)
                local d = drapeauxDeFonction(f)
                if d:find("Net") then
                    nf = nf + 1
                    noter(string.format("    %-30s %-40s%s", classe, nomF, d))
                end
            end, MAX_FONCTIONS)
            if nf == 0 then noter("    (aucune)") end
        end
    end

    -- ══ 4. La construction : ce qui est déjà posé dans le monde ═══════════
    titre("CONSTRUCTIONS DEJA POSEES")
    noter("On cherche ce qui ressemble a une piece construite, et on en decrit")
    noter("une seule en entier : c'est la description complete qui sert, pas la")
    noter("liste des noms.")

    local CLASSES_CONSTRUCTION = {
        "BP_Module_Solar_C", "BP_Module_Diesel_Container_C", "BP_Module_Base_C",
        "BP_Buildable_C", "BP_Build_Module_C", "BP_Placeable_C",
        "BP_Module_Grinder_C", "BP_Module_Container_C", "BP_Inventory_Container_Fishing_C",
        "BP_Cable_C", "BP_Module_Cable_C", "BP_Boat_C", "BP_Raft_C",
    }
    local decrite = false
    for _, classe in ipairs(CLASSES_CONSTRUCTION) do
        local trouves = sur(function() return FindAllOf(classe) end, nil)
        local n = sur(function() return #trouves end, 0)
        if n and n > 0 then
            noter("")
            noter("  " .. classe .. " : " .. n .. " dans le monde")
            if not decrite then
                local premier = sur(function() return trouves[1]:get() end, nil)
                    or sur(function() return trouves[1] end, nil)
                if estValide(premier) then
                    fouillerConstruction(premier, "exemple de " .. classe)
                    decrite = true
                end
            end
        end
    end
    if not decrite then
        noter("  Aucune de ces classes n'est posee. POSE UN OBJET puis appuie sur")
        noter("  F8 : la sonde refait ce bloc, et le crochet POSE aura ecrit ses")
        noter("  arguments juste au-dessus.")
    end

    -- == 4b. LE RECENSEMENT COMPLET : tout ce qui porte un nom du jeu ====
    titre("RECENSEMENT COMPLET DU MONDE")
    noter("On balaie TOUS les acteurs charges et on les regroupe par classe.")
    noter("C'est la liste de tout ce qui pourrait avoir besoin d'etre synchronise,")
    noter("et elle est tiree du monde reel, pas d'une liste de noms devines.")

    --[[
      ATTENTION : ON NE DEVINE PLUS LES NOMS DE CLASSES. La premiere version
      essayait une liste de `BP_Module_Solar_C` et compagnie ; si le jeu les
      appelle autrement, elle ne trouve rien et on conclut a tort qu il n y a
      rien. Ici on part de `AActor` et on laisse le monde se decrire.

      ATTENTION : LE COMPTE EST PLAFONNE. Une partie chargee porte des
      dizaines de milliers d acteurs ; on compte tout, on en DECRIT peu.
    ]]
    local familles = {}
    local totalActeurs = 0
    sur(function()
        local classeActeur = StaticFindObject("/Script/Engine.Actor")
        local tous = FindAllOf("Actor")
        local n = sur(function() return #tous end, 0)
        totalActeurs = n
        for i = 1, math.min(n, 20000) do
            local a = sur(function() return tous[i]:get() end, nil)
                or sur(function() return tous[i] end, nil)
            if a ~= nil then
                local c = sur(function() return a:GetClass():GetFName():ToString() end, nil)
                if c then
                    if familles[c] == nil then familles[c] = { n = 0, exemple = a } end
                    familles[c].n = familles[c].n + 1
                end
            end
        end
        return true
    end, nil)

    noter("  " .. totalActeurs .. " acteur(s) charges au total")

    --[[
      Ce qui nous interesse vraiment : ce qui ressemble a une construction, un
      mur, un cable, un conteneur, une machine. On trie par mot-cle et on dit
      combien il y en a de chaque.
    ]]
    local MOTS = {
        "module", "build", "wall", "mur", "floor", "roof", "ceiling", "door",
        "hatch", "window", "ramp", "stair", "foundation", "pillar", "beam",
        "cable", "wire", "pipe", "conduit", "conveyor",
        "container", "chest", "storage", "crate", "locker", "inventory",
        "grinder", "crafting", "bench", "forge", "generator", "solar", "battery",
        "turbine", "diesel", "fuel", "tank", "panel", "switch", "lever", "button",
        "placeable", "buildable", "deployable", "structure", "platform", "raft", "boat",
    }
    local classees = {}
    for classe, info in pairs(familles) do
        local bas = classe:lower()
        for _, mot in ipairs(MOTS) do
            if bas:find(mot, 1, true) then
                classees[#classees + 1] = { classe = classe, n = info.n, exemple = info.exemple, mot = mot }
                break
            end
        end
    end
    table.sort(classees, function(a, b) return a.n > b.n end)

    sousTitre("Ce qui ressemble a une construction, un mur, une machine")
    noter(string.format("  %-52s %6s  %s", "classe", "nombre", "mot-cle"))
    for i, e in ipairs(classees) do
        if i > 150 then noter("  (... et d'autres, plafond atteint)") break end
        noter(string.format("  %-52s %6d  %s", e.classe, e.n, e.mot))
    end
    if #classees == 0 then
        noter("  Aucune. Le bloc suivant liste alors les 80 classes les plus")
        noter("  nombreuses du monde : le bon nom est forcement dedans.")
    end

    --[[
      ATTENTION : ON LISTE AUSSI LES PLUS NOMBREUSES, SANS FILTRE. Si aucun de
      nos mots-cles ne colle, c est que le jeu nomme ses pieces autrement --
      et la liste brute est alors la seule chose utile du fichier.
    ]]
    sousTitre("Les 80 classes les plus nombreuses, sans filtre")
    local brutes = {}
    for classe, info in pairs(familles) do brutes[#brutes + 1] = { classe = classe, n = info.n } end
    table.sort(brutes, function(a, b) return a.n > b.n end)
    for i = 1, math.min(#brutes, 80) do
        noter(string.format("  %-56s %6d", brutes[i].classe, brutes[i].n))
    end

    -- == 4c. TROIS EXEMPLES DECRITS EN ENTIER ============================
    titre("TROIS CONSTRUCTIONS DECRITES EN ENTIER")
    noter("Une liste de noms ne sert a rien ; une description complete, si.")
    noter("On prend les trois familles les plus nombreuses parmi celles qui")
    noter("ressemblent a une construction, et on vide leurs poches.")
    local decrites = 0
    for _, e in ipairs(classees) do
        if decrites >= 3 then break end
        if estValide(e.exemple) then
            noter("")
            fouillerConstruction(e.exemple, e.classe .. " (" .. e.n .. " dans le monde)")
            decrites = decrites + 1
        end
    end
    if decrites == 0 then
        noter("  Rien a decrire. POSE UN MUR ou un panneau, puis appuie sur F8.")
    end

    -- == 4d. LA GRILLE ET L ACCROCHAGE ===================================
    titre("GRILLE, ACCROCHAGE, POSITION DE CASE")
    noter("Pour reconstruire une piece chez l autre joueur il faut sa CASE, pas")
    noter("seulement sa position en centimetres. On cherche donc qui sait")
    noter("convertir l une en l autre.")

    --[[
      ATTENTION : LA POSITION DE GRILLE PEUT ETRE SUR LA PIECE ELLE-MEME. On
      cherche d abord les proprietes qui en portent le nom sur un exemple
      pose ; c est le chemin le plus court et personne ne l avait regarde.
    ]]
    if decrites > 0 then
        local exemple = classees[1].exemple
        sousTitre("Proprietes de l exemple qui parlent de grille ou d accrochage")
        local n = 0
        pourChaquePropriete(sur(function() return exemple:GetClass() end, nil),
            function(st, nomP, typeP, dra)
                local bas = nomP:lower()
                if bas:find("grid") or bas:find("snap") or bas:find("cell")
                    or bas:find("socket") or bas:find("slot") or bas:find("anchor")
                    or bas:find("attach") or bas:find("parent") or bas:find("index")
                    or bas:find("coord") or bas:find("tile") or bas:find("module") then
                    n = n + 1
                    local v = sur(function() return exemple[nomP] end, nil)
                    noter(string.format("    %-30s %-16s = %s%s", nomP, typeP, decrire(v, 1), dra))
                end
            end, MAX_PROPRIETES)
        if n == 0 then noter("    (aucune : la grille est ailleurs)") end

        sousTitre("Fonctions de l exemple qui parlent de grille ou d accrochage")
        local nf = 0
        pourChaqueFonction(exemple, function(c, nomF, f)
            local bas = nomF:lower()
            if bas:find("grid") or bas:find("snap") or bas:find("cell")
                or bas:find("attach") or bas:find("socket") or bas:find("place")
                or bas:find("build") or bas:find("module") then
                nf = nf + 1
                noter(string.format("    %-46s%s", nomF, drapeauxDeFonction(f)))
            end
        end, MAX_FONCTIONS)
        if nf == 0 then noter("    (aucune)") end
    end

    -- == 4e. LES COMPOSANTS DE CONSTRUCTION DU JOUEUR =====================
    titre("CE QUE LE JOUEUR PORTE POUR CONSTRUIRE")
    noter("Le composant qui tient le mode construction sait forcement ce qui va")
    noter("etre pose, ou, et accroche a quoi. C est le meilleur endroit du jeu")
    noter("pour apprendre la forme exacte d une pose.")
    local classeComposant2 = sur(function() return StaticFindObject("/Script/Engine.ActorComponent") end, nil)
    local composantsJoueur = sur(function() return pion:K2_GetComponentsByClass(classeComposant2) end, nil)
    local vusCJ = pourChaque(composantsJoueur, function(c)
        local nomC = nomDeClasse(c):lower()
        local interessant = nomC:find("build") or nomC:find("place") or nomC:find("module")
            or nomC:find("construct") or nomC:find("inventor") or nomC:find("equip")
            or nomC:find("interact") or nomC:find("grid")
        noter("  " .. nomCourt(c) .. "  <" .. nomDeClasse(c) .. ">" .. (interessant and "   <-- A REGARDER" or ""))
        if interessant then
            noter("    heritage : " .. hierarchie(c))
            pourChaqueFonction(c, function(cl, nomF, f)
                noter(string.format("      %-44s%s", nomF, drapeauxDeFonction(f)))
            end, 120)
            pourChaquePropriete(sur(function() return c:GetClass() end, nil),
                function(st, nomP, typeP, dra)
                    local v = sur(function() return c[nomP] end, nil)
                    noter(string.format("      %-28s %-16s = %s%s", nomP, typeP, decrire(v, 1), dra))
                end, 120)
        end
    end, 60)
    if vusCJ == 0 then noter("  (liste indisponible)") end

    -- ══ 5. Le gestionnaire de construction, s'il existe ═══════════════════
    titre("GESTIONNAIRES ET SOUS-SYSTEMES")
    noter("Celui qui tient la grille de construction sait forcement convertir une")
    noter("position en case. Si on le trouve, on trouve la position de grille.")
    for _, classe in ipairs({
        "VoyageBuildManager", "VoyageBuildingSubsystem", "VoyageGridManager",
        "VoyageModuleManager", "VoyageGameMode", "VoyageGameState",
        "BP_VoyageGameMode_C", "BP_GameState_C", "VoyageSaveGame", "VoyageWorldSubsystem",
    }) do
        local trouves = sur(function() return FindAllOf(classe) end, nil)
        local n = sur(function() return #trouves end, 0)
        if n and n > 0 then
            local premier = sur(function() return trouves[1]:get() end, nil)
                or sur(function() return trouves[1] end, nil)
            noter("")
            noter("  " .. classe .. " : TROUVE (" .. n .. ")")
            if estValide(premier) then
                noter("    " .. nomComplet(premier))
                noter("    heritage : " .. hierarchie(premier))
                sousTitre(classe .. " : fonctions")
                pourChaqueFonction(premier, function(c, nomF, f)
                    noter(string.format("    %-30s %-44s%s", c, nomF, drapeauxDeFonction(f)))
                end, 150)
                sousTitre(classe .. " : proprietes")
                pourChaquePropriete(sur(function() return premier:GetClass() end, nil),
                    function(st, nomP, typeP, dra)
                        noter(string.format("    %-22s %-30s %-16s%s", st, nomP, typeP, dra))
                    end, 150)
            end
        end
    end

    -- ══ 6. La sauvegarde : la carte de ce qui compte ══════════════════════
    titre("SAUVEGARDE : CE QUE LE JEU PERSISTE LUI-MEME")
    noter("Le format de sauvegarde est la meilleure carte de ce qui compte dans")
    noter("ce monde : tout ce que le jeu ecrit sur le disque est un etat qu'il")
    noter("considere comme faisant partie de la partie.")
    for _, classe in ipairs({
        "VoyageSaveGame", "BP_SaveGame_C", "VoyageSaveSubsystem", "VoyagePersistenceComponent",
    }) do
        local trouves = sur(function() return FindAllOf(classe) end, nil)
        local n = sur(function() return #trouves end, 0)
        if n and n > 0 then
            local premier = sur(function() return trouves[1]:get() end, nil)
                or sur(function() return trouves[1] end, nil)
            noter("")
            noter("  " .. classe .. " : TROUVE")
            if estValide(premier) then
                pourChaquePropriete(sur(function() return premier:GetClass() end, nil),
                    function(st, nomP, typeP, dra)
                        local v = sur(function() return premier[nomP] end, nil)
                        noter(string.format("    %-28s %-16s = %s%s", nomP, typeP, decrire(v, 1), dra))
                    end, 200)
            end
        else
            noter("  " .. classe .. " : absent")
        end
    end

    -- ══ 7. Les proprietes `SaveGame` du pion ══════════════════════════════
    titre("PROPRIETES MARQUEES `SaveGame`")
    noter("Unreal marque les champs que la sauvegarde embarque. Sur le pion, ce")
    noter("sont exactement les champs qui decrivent un joueur de facon durable.")
    local nsg = 0
    pourChaquePropriete(sur(function() return pion:GetClass() end, nil),
        function(st, nomP, typeP, dra)
            if dra:find("SaveGame") then
                nsg = nsg + 1
                local v = sur(function() return pion[nomP] end, nil)
                noter(string.format("    %-28s %-16s = %s", nomP, typeP, decrire(v, 1)))
            end
        end, MAX_PROPRIETES)
    if nsg == 0 then noter("    (aucune, ou les drapeaux ne sont pas lisibles ici)") end

    -- == 8. TOUT LE JEU, PAS SEULEMENT LE MONDE CHARGE ==================
    titre("TOUT CE QUI EXISTE EN MEMOIRE")
    noter("Le monde charge dit ce qui est POSE. Le registre des objets dit ce")
    noter("qui EXISTE. Au debut d une partie le premier est presque vide et le")
    noter("second est deja plein : c est la que vivent les definitions d objets,")
    noter("d outils et de pieces, qu on ait pose quelque chose ou non.")
    noter("")
    noter("Ce balayage prend une dizaine de secondes. Le jeu peut saccader.")

    --[[
      ATTENTION : `ForEachUObject` PARCOURT TOUT CE QUE LE MOTEUR A EN MEMOIRE,
      classes comprises -- des centaines de milliers d entrees. On compte tout,
      on en ECRIT peu, et on garde de cote celles qui nous interessent.

      ATTENTION : SI CETTE FONCTION N EXISTE PAS DANS CETTE VERSION D UE4SS, on
      le DIT. Un balayage qui ne trouve rien et un balayage qui n a pas eu lieu
      se ressemblent beaucoup dans un fichier, et seul le second se repare.
    ]]
    local MOTS_OBJETS = {
        "item", "tool", "weapon", "gun", "axe", "knife", "pickaxe", "hammer",
        "resource", "material", "ore", "scrap", "metal", "wood", "plank", "fiber",
        "food", "drink", "water", "fuel", "battery", "cell", "ammo", "medkit",
        "craft", "recipe", "blueprint", "schematic", "loot", "pickup", "drop",
        "equip", "armor", "suit", "helmet", "backpack", "bag", "container",
        "consumable", "seed", "plant", "fish", "component", "part", "module",
        "prop", "placeable", "buildable", "deployable", "structure", "wall",
        "floor", "roof", "door", "hatch", "window", "ramp", "stair", "foundation",
        "pillar", "beam", "cable", "wire", "pipe", "panel", "solar", "generator",
        "grinder", "bench", "forge", "turbine", "diesel", "tank", "storage",
    }

    local parType = {}
    local classesInteressantes = {}
    local tablesDeDonnees = {}
    local toutesClassesBP = {}
    local vusUObject = 0
    local balayageFait = false

    balayageFait = sur(function()
        ForEachUObject(function(objet)
            vusUObject = vusUObject + 1
            local nomC = sur(function() return objet:GetClass():GetFName():ToString() end, nil)
            if nomC == nil then return end
            parType[nomC] = (parType[nomC] or 0) + 1

            local nomO = sur(function() return objet:GetFName():ToString() end, "")
            local bas = nomO:lower()

            -- Les tables de donnees : c est la que vivent les listes d objets.
            if nomC == "DataTable" then
                tablesDeDonnees[#tablesDeDonnees + 1] = objet
                return
            end

            --[[
              Une classe Blueprint porte le suffixe `_C`. Toutes les definitions
              d objets du jeu en sont, et elles sont en memoire bien avant qu on
              en pose une seule.
            ]]
            if nomC == "BlueprintGeneratedClass" or nomC == "Class" then
                if #toutesClassesBP < 6000 then toutesClassesBP[#toutesClassesBP + 1] = nomO end
                for _, mot in ipairs(MOTS_OBJETS) do
                    if bas:find(mot, 1, true) then
                        if #classesInteressantes < 2500 then
                            classesInteressantes[#classesInteressantes + 1] = { nom = nomO, objet = objet, mot = mot }
                        end
                        break
                    end
                end
            end
        end)
        return true
    end, false)

    if not balayageFait then
        noter("  ECHEC : `ForEachUObject` n est pas disponible dans cette version")
        noter("  d UE4SS. Rien n a ete balaye -- ce n est pas la meme chose que")
        noter("  <<rien trouve>>. Dis-le-moi, il y a d autres chemins.")
    else
        noter("  " .. vusUObject .. " objet(s) en memoire")
        noter("  " .. #toutesClassesBP .. " classe(s)")
        noter("  " .. #classesInteressantes .. " classe(s) qui ressemblent a un objet du jeu")
        noter("  " .. #tablesDeDonnees .. " table(s) de donnees")
        poser()

        sousTitre("Les types d objets les plus nombreux en memoire")
        local types = {}
        for k, v in pairs(parType) do types[#types + 1] = { k = k, v = v } end
        table.sort(types, function(a, b) return a.v > b.v end)
        for i = 1, math.min(#types, 60) do
            noterDiscret(string.format("  %-54s %7d", types[i].k, types[i].v))
        end
        poser()
    end

    -- == 8b. LES TABLES DE DONNEES : LA LISTE DES OBJETS DU JEU ==========
    titre("TABLES DE DONNEES")
    noter("Une table de donnees contient une ligne par objet du jeu : nom,")
    noter("quantite empilable, icone, description. C est la reponse la plus")
    noter("directe a <<quels objets existent>>, et elle ne demande rien au joueur.")

    --[[
      ATTENTION : ON ESSAIE PLUSIEURS CHEMINS POUR LIRE LES LIGNES. `RowMap` est
      une TMap que le Lua ne lit pas toujours ; `GetRowNames` est une fonction de
      bibliotheque Blueprint qui, elle, passe souvent. On tente les deux et on
      ecrit ce qui a marche, pas ce qui aurait du marcher.
    ]]
    local biblioTable = sur(function()
        return StaticFindObject("/Script/Engine.Default__DataTableFunctionLibrary")
    end, nil)
    noter("  bibliotheque DataTable : " .. (estValide(biblioTable) and "trouvee" or "ABSENTE"))

    for i, tbl in ipairs(tablesDeDonnees) do
        if i > 60 then
            noter("  (... " .. (#tablesDeDonnees - 60) .. " autres tables, plafond atteint)")
            break
        end
        noter("")
        noter("  TABLE : " .. nomComplet(tbl))
        local structure = sur(function() return tbl.RowStruct end, nil)
        noter("    structure de ligne : " .. (estValide(structure) and nomCourt(structure) or "?"))

        -- Les champs d une ligne : ils decrivent ce qu un objet porte.
        if estValide(structure) then
            local nchamps = pourChaquePropriete(structure, function(st, nomP, typeP, dra)
                noterDiscret(string.format("      champ %-28s %-16s%s", nomP, typeP, dra))
            end, 60)
            if nchamps == 0 then noter("      (champs illisibles)") end
        end

        local noms = nil
        if estValide(biblioTable) then
            noms = sur(function() return biblioTable:GetDataTableRowNames(tbl) end, nil)
        end
        if noms == nil then noms = sur(function() return tbl:GetRowNames() end, nil) end

        local n = sur(function() return #noms end, nil)
        if n == nil then
            noter("    lignes : ILLISIBLES par ce chemin")
        else
            noter("    lignes : " .. n)
            local montrees = pourChaque(noms, function(e, k)
                noterDiscret("      [" .. k .. "] " .. decrire(e, 1))
            end, 400)
            if n > montrees then noter("      (... " .. (n - montrees) .. " autres)") end
        end
        poser()
    end
    if #tablesDeDonnees == 0 then
        noter("  Aucune table de donnees en memoire.")
    end

    -- == 8c. LES OBJETS DU JEU, PAR LEUR CLASSE PAR DEFAUT ===============
    titre("LES OBJETS DU JEU, SANS EN POSER UN SEUL")
    noter("Chaque classe porte un exemplaire par defaut -- le <<CDO>> -- dont les")
    noter("proprietes sont celles de l objet avant toute partie : son nom, sa")
    noter("quantite empilable, son maillage, sa recette. On le lit sans rien")
    noter("poser, sans rien ramasser, et sans avoir commence a jouer.")

    table.sort(classesInteressantes, function(a, b) return a.nom < b.nom end)
    sousTitre("Les classes trouvees (" .. #classesInteressantes .. ")")
    for i, c in ipairs(classesInteressantes) do
        noterDiscret(string.format("  %-62s %s", c.nom, c.mot))
        if i % 500 == 0 then poser() end
    end
    poser()

    --[[
      ATTENTION : ON NE VIDE PAS LES POCHES DE DEUX MILLE CLASSES. Le fichier
      ferait des dizaines de megaoctets et personne ne le lirait. On decrit en
      entier les PREMIERES, et la liste complete est juste au-dessus : si une
      classe t interesse, dis-la-moi et on la regarde.
    ]]
    sousTitre("Les " .. math.min(#classesInteressantes, 120) .. " premieres, poches videes")
    for i = 1, math.min(#classesInteressantes, 120) do
        local c = classesInteressantes[i]
        local cdo = sur(function() return c.objet:GetCDO() end, nil)
            or sur(function() return c.objet:GetClassDefaultObject() end, nil)
            or sur(function() return StaticFindObject(nomComplet(c.objet):gsub("^%S+ ", "")) end, nil)
        noterDiscret("")
        noterDiscret("  " .. c.nom)
        if not estValide(cdo) then
            noterDiscret("    (exemplaire par defaut illisible)")
        else
            noterDiscret("    heritage : " .. hierarchie(cdo))
            local n = pourChaquePropriete(sur(function() return cdo:GetClass() end, nil),
                function(st, nomP, typeP, dra)
                    local v = sur(function() return cdo[nomP] end, nil)
                    -- Un champ vide ne dit rien : on ne l ecrit pas.
                    if v ~= nil and v ~= 0 and v ~= false and v ~= "" then
                        noterDiscret(string.format("    %-28s %-16s = %s%s", nomP, typeP, decrire(v, 1), dra))
                    end
                end, 80)
            if n == 0 then noterDiscret("    (aucune propriete lisible)") end
        end
        if i % 20 == 0 then poser() end
    end
    poser()

    -- == 8d. TOUTES LES CLASSES, SANS FILTRE =============================
    titre("TOUTES LES CLASSES DU JEU, SANS FILTRE")
    noter("Si aucun de mes mots-cles ne colle, le bon nom est forcement dans")
    noter("cette liste. Elle est longue ; c est voulu. Cherche dedans.")
    table.sort(toutesClassesBP)
    for i, nom in ipairs(toutesClassesBP) do
        noterDiscret("  " .. nom)
        if i % 1000 == 0 then poser() end
    end
    poser()

    -- == 8e. LE REGISTRE DES ASSETS : CE QUI EST SUR LE DISQUE ===========
    titre("REGISTRE DES ASSETS")
    noter("Tout ce qui precede ne voit que ce qui est CHARGE. Le registre des")
    noter("assets, lui, connait ce qui est sur le disque -- y compris ce que le")
    noter("jeu n a pas encore ouvert.")

    --[[
      ATTENTION : CE CHEMIN ECHOUE SOUVENT, ET C EST ACCEPTABLE. Il demande des
      parametres de sortie que le Lua d UE4SS ne sait pas toujours passer. On
      essaie, on dit ce qui s est passe, et le reste du fichier garde sa valeur.
    ]]
    local aides = sur(function()
        return StaticFindObject("/Script/AssetRegistry.Default__AssetRegistryHelpers")
    end, nil)
    noter("  AssetRegistryHelpers : " .. (estValide(aides) and "trouve" or "ABSENT"))
    if estValide(aides) then
        local registre = sur(function() return aides:GetAssetRegistry() end, nil)
        noter("  registre : " .. (registre ~= nil and "obtenu" or "ILLISIBLE"))
        if registre ~= nil then
            local tout = sur(function() return registre:GetAllAssets({}, false) end, nil)
            local n = sur(function() return #tout end, nil)
            if n == nil then
                noter("  GetAllAssets : illisible depuis le Lua (parametre de sortie).")
                noter("  Ce n est pas grave : les sections precedentes couvrent ce qui")
                noter("  est charge, et le jeu charge ses definitions d objets tot.")
            else
                noter("  " .. n .. " asset(s) sur le disque")
                pourChaque(tout, function(a, k)
                    noterDiscret("    [" .. k .. "] " .. decrire(a, 1))
                end, 3000)
                poser()
            end
        end
    end

    titre("FIN DU RELEVE INITIAL")
    noter("A partir d'ici, seules les PRISES des crochets s'ajoutent.")
    noter("")
    noter("TU N AS RIEN A FAIRE. Le releve ci-dessus est complet : il a lu le")
    noter("registre des objets du jeu, pas seulement ce qui est pose autour de toi.")
    noter("")
    noter("A PARTIR D ICI, L OBSERVATEUR TRAVAILLE TOUT SEUL. Toutes les vingt")
    noter("secondes il compare le monde a ce qu il etait, et ecrit ce qui a change :")
    noter("un objet depose au sol, une piece construite, un conteneur ouvert, une")
    noter("creature apparue. Une classe jamais vue est decrite en entier.")
    noter("")
    noter("Tu n as rien a declencher. Joue, et renvoie-moi le fichier quand tu veux.")
    noter("F8 refait le releve complet en gardant les prises et les observations.")
    noter("")
    noter("Envoie-moi le fichier entier. Les lignes [PRISE] sont les plus")
    noter("importantes : elles disent ce que le jeu donne vraiment.")
    return true
end

-- =========================================================================
--  L OBSERVATEUR : ce qui ARRIVE, pas seulement ce qui EST
-- =========================================================================

--[[
  Le releve initial decrit le jeu. L observateur decrit les EVENEMENTS : tu
  deposes un objet au sol, tu construis une piece, un conteneur apparait, une
  creature se montre. Il compare le monde a ce qu il etait il y a vingt
  secondes et ecrit uniquement la difference.

  ATTENTION : IL N A PAS BESOIN QUE TU FASSES QUOI QUE CE SOIT. Tu joues
  normalement, le fichier se remplit. C est exactement la raison d etre de ce
  bloc : un crochet ne prend que si le jeu appelle la fonction qu on a devinee,
  alors qu une comparaison du monde attrape TOUT ce qui apparait, quel que soit
  le chemin que le jeu a pris pour le faire apparaitre.

  ATTENTION : ON COMPARE DES COMPTES PAR CLASSE, PAS DES LISTES D OBJETS.
  Garder la liste des dizaines de milliers d acteurs a chaque tour couterait
  plus cher que tout le reste de la sonde. Un compte par classe suffit a dire
  << il y en a un de plus qu avant >>, et c est la question.
]]

--- Entre deux regards. Assez court pour relier un geste a ce qui apparait.
local OBSERVATION_MS = 20000

--- Au-dela, l observateur se tait : un fichier sans fin ne se lit pas.
local OBSERVATIONS_MAX = 400

--- Combien de nouveaux venus on decrit EN ENTIER (le reste est juste nomme).
local DESCRIPTIONS_MAX = 25

local avant = nil
local observations = 0
local descriptions = 0
local toursObserves = 0

--- Le monde, resume : une entree par classe, avec un exemplaire sous la main.
local function recenser()
    local table_ = {}
    sur(function()
        local tous = FindAllOf("Actor")
        local n = sur(function() return #tous end, 0)
        for i = 1, math.min(n, 20000) do
            local a = sur(function() return tous[i]:get() end, nil)
                or sur(function() return tous[i] end, nil)
            if a ~= nil then
                local c = sur(function() return a:GetClass():GetFName():ToString() end, nil)
                if c then
                    if table_[c] == nil then table_[c] = { n = 0, dernier = a } end
                    table_[c].n = table_[c].n + 1
                    table_[c].dernier = a
                end
            end
        end
        return true
    end, nil)
    return table_
end

local function observer()
    if not pret then
        ExecuteWithDelay(OBSERVATION_MS, observer)
        return
    end
    if observations >= OBSERVATIONS_MAX then
        noter("")
        noter("(observateur : " .. OBSERVATIONS_MAX .. " changements notes, il se tait.)")
        poser()
        observations = observations + 1
        return
    end

    sur(function()
        local maintenant = recenser()
        toursObserves = toursObserves + 1

        if avant == nil then
            avant = maintenant
            noter("")
            noter("[OBSERVATEUR] en marche. Joue normalement : depose un objet,")
            noter("              construis, ouvre un coffre. Ce qui apparait est ecrit ici.")
            poser()
            ExecuteWithDelay(OBSERVATION_MS, observer)
            return true
        end

        local nouveautes = {}
        for classe, info in pairs(maintenant) do
            local vieux = avant[classe]
            local ecart = info.n - (vieux and vieux.n or 0)
            if ecart > 0 then
                nouveautes[#nouveautes + 1] = { classe = classe, ecart = ecart, exemple = info.dernier,
                    neuve = (vieux == nil) }
            end
        end
        --[[
          ATTENTION : LES DISPARITIONS COMPTENT AUSSI. Ramasser un objet au sol
          le fait disparaitre ; c est le meme evenement vu de l autre cote, et
          c est la moitie de ce qu il faudrait synchroniser.
        ]]
        local pertes = {}
        for classe, info in pairs(avant) do
            local maint = maintenant[classe]
            local ecart = (maint and maint.n or 0) - info.n
            if ecart < 0 then pertes[#pertes + 1] = { classe = classe, ecart = -ecart } end
        end

        if #nouveautes > 0 or #pertes > 0 then
            observations = observations + 1
            noter("")
            noter("[OBSERVATEUR " .. observations .. "] tour " .. toursObserves)

            table.sort(nouveautes, function(a, b) return a.ecart > b.ecart end)
            for _, e in ipairs(nouveautes) do
                noter(string.format("  + %-54s %d%s", e.classe, e.ecart,
                    e.neuve and "   <-- CLASSE JAMAIS VUE" or ""))
            end
            for _, e in ipairs(pertes) do
                noter(string.format("  - %-54s %d", e.classe, e.ecart))
            end

            --[[
              ATTENTION : ON DECRIT EN ENTIER CE QUI EST NOUVEAU, pas ce qui est
              seulement plus nombreux. Une classe jamais vue qui apparait quand tu
              deposes quelque chose, c est exactement la definition qu on cherche ;
              un dixieme caillou de plus n apprend rien.
            ]]
            for _, e in ipairs(nouveautes) do
                if e.neuve and descriptions < DESCRIPTIONS_MAX and estValide(e.exemple) then
                    descriptions = descriptions + 1
                    noter("")
                    fouillerConstruction(e.exemple, "NOUVEAU : " .. e.classe)
                end
            end
            poser()
        end

        avant = maintenant
        return true
    end, nil)

    ExecuteWithDelay(OBSERVATION_MS, observer)
end

pcall(function()
    ExecuteWithDelay(OBSERVATION_MS * 2, observer)
end)

-- ═══════════════════════════════════════════════════════════════════════════
--  Mise en route
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ ELLE NE DEPEND PAS D'UNE TOUCHE POUR DEMARRER. Si le raccourci n'arrive
     jamais — fenetre pas focalisee, touche deja prise, mod charge avant le jeu
     — on croit que rien ne marche. Elle reessaie donc toute seule.
]]
local function boucle()
    if pret then return end
    essais = essais + 1
    if essais > ESSAIS_MAX then
        print("[" .. NOM .. "] abandon : aucune partie chargee apres une heure.\n")
        return
    end
    local ok = sur(function() return sonder() end, false)
    if ok then
        pret = true
        print("[" .. NOM .. "] releve ecrit dans " .. FICHIER .. "\n")
        return
    end
    ExecuteWithDelay(INTERVALLE_MS, boucle)
end

pcall(function()
    ExecuteWithDelay(5000, boucle)
end)

--[[
  ⚠️ `RegisterKeyBind` SE DECLENCHE HORS DU FIL DU JEU. Toucher aux objets
     d'Unreal depuis la, c'est un plantage une fois sur dix : on repasse par
     `ExecuteInGameThread`.
]]
pcall(function()
    RegisterKeyBind(Key.F8, function()
        ExecuteInGameThread(function()
            pcall(function()
                print("[" .. NOM .. "] F8 : on refait le releve.\n")
                local garde = {}
                for _, l in ipairs(lignes) do garde[#garde + 1] = l end
                pret = false
                essais = 0
                if sonder() then
                    pret = true
                    -- On remet les prises d'avant au-dessus : elles sont la valeur du fichier.
                    local tout = { "=== PRISES DU RELEVE PRECEDENT ===" }
                    for _, l in ipairs(garde) do
                        if l:find("%[PRISE") then tout[#tout + 1] = l end
                    end
                    tout[#tout + 1] = ""
                    for _, l in ipairs(lignes) do tout[#tout + 1] = l end
                    lignes = tout
                    pcall(ecrire)
                end
            end)
        end)
    end)
end)

print("[" .. NOM .. "] charge. Le releve part tout seul des qu'une partie tourne. F8 pour le refaire.\n")
