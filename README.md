# Elise-10 : suivi du code promo Phlame

Page publique qui récapitule les ventes réalisées avec le code promo `Elise-10`
sur la boutique Shopify Phlame : https://nebuyr168.github.io/elise-10/

Aucune donnée client n'est publiée, uniquement des totaux par jour et par produit.

## Mise à jour

Une GitHub Action (`.github/workflows/refresh.yml`) interroge Shopify toutes les
heures et réécrit `data/elise-10.json`. Elle peut aussi être lancée à la main
depuis l'onglet **Actions**, workflow *Refresh Elise-10 data*, bouton **Run workflow**.

Elle a besoin des secrets `SHOPIFY_CLIENT_ID` et `SHOPIFY_CLIENT_SECRET` :
identifiants d'une application créée dans le Dev Dashboard Shopify, installée
sur la boutique, avec les portées `read_orders`, `read_all_orders` et
`read_discounts`. Le script les échange contre un token valable 24 h
(client credentials grant) à chaque exécution.

## Mise à jour manuelle sans token

`node scripts/fetch.mjs --orders raw-orders.json` agrège un export GraphQL
sauvegardé (format : `{ shop, code, orders }`) sans appeler l'API.
