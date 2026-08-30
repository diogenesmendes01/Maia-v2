// Tailwind 4: o plugin de PostCSS saiu do pacote `tailwindcss` e virou
// `@tailwindcss/postcss`. Manter `tailwindcss: {}` aqui é EXATAMENTE o que
// reprova o build no major — o próprio pacote detecta o uso indevido e lança
// "It looks like you're trying to use `tailwindcss` directly as a PostCSS
// plugin", que foi como a PR automática do Dependabot (#654) morreu em
// `next build`, em `./styles/globals.css`.
//
// `autoprefixer` SAIU e não foi substituído: o Tailwind 4 processa a folha com
// Lightning CSS, que já aplica os prefixos de fornecedor para o alvo de
// browsers do próprio Tailwind (Safari 16.4+, Chrome 111+, Firefox 128+). O
// único prefixo escrito à mão na árvore é `::-webkit-scrollbar` em
// `styles/globals.css`, que é uma pseudo-classe proprietária — nada a
// prefixar. Deixar o autoprefixer no pipeline seria uma passada a mais sem
// efeito e uma devDependency a mais no lockfile.
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
