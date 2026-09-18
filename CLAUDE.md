# Lapo-Bardotti — perfil do GitHub

Repositório de perfil. O README é montado sobre SVGs gerados, não escritos à mão.

## Estrutura

- `scripts/generate-cards.mjs` — busca a GraphQL do GitHub e renderiza os SVGs. Sem dependências.
- `assets/*.svg` — artefatos de build. Nunca editar à mão; em conflito de merge, regerar.
- `.github/workflows/cards.yml` — regenera diariamente (cron 05:17 UTC) e commita se houver mudança.

## Comandos

```bash
# gera os cards no repo
GH_TOKEN=$(gh auth token) GH_USER=Lapo-Bardotti node scripts/generate-cards.mjs

# gera fora do repo, para preview sem sujar assets/
CARDS_OUT=/tmp/preview GH_TOKEN=$(gh auth token) GH_USER=Lapo-Bardotti node scripts/generate-cards.mjs
```

## Regras

- **Largura**: a coluna do README de perfil mede 846px, mais estreita que a de repositório.
  Cards full = 840, metade = 415. Dois cards de metade mais o espaço inline entre eles têm de
  caber em 846 ou o browser quebra a linha.
- **Nada de `<table>` no README**: o GitHub força `border: 1px` em `td`/`th` e remove atributos
  `style`, então tabela sempre aparece com borda. Usar imagens inline, que ainda empilham no mobile.
- **Fonte**: `@import` de fonte não funciona em SVG dentro do GitHub. Usar a font stack do sistema,
  que é a mesma do GitHub e dá o aspecto nativo.
- **Tema**: cada SVG traz `@media (prefers-color-scheme: dark)` no próprio `<style>`. Isso segue o
  sistema operacional do leitor, não o toggle de tema do GitHub.
- **Conteúdo curado** (`IMPACT`, `STACK_FALLBACK`) fica no topo do script — é o que a API não sabe.
  Não inventar número que a API não fornece.
- **Dados privados**: com o secret `CARDS_TOKEN` (PAT classic, escopo `repo`) o script destrava
  linguagem por bytes e tipo de commit dos repositórios privados. Sem ele cai no fallback em
  silêncio, sem quebrar. O `GITHUB_TOKEN` padrão não enxerga repositório privado.
- **Cache**: `raw.githubusercontent` serve com `max-age=300`. Depois de um push, os cards levam
  alguns minutos para atualizar na página — medir tamanho pelo arquivo no remoto, não pelo browser.
