-- Sibling `_down` da migration deliberadamente quebrada do drill da #705.
--
-- Existe por duas razoes:
--
--   1. o runner RECUSA aplicar qualquer coisa quando uma migration forward do
--      artefato nao tem `_down.sql` irma. Sem este arquivo o drill nem
--      chegaria a falhar pelo motivo certo: seria bloqueado antes, como
--      problema de artefato, e a evidencia do item 2 seria outra coisa;
--
--   2. ele e o desfazer do efeito parcial. Nenhum runner o executa
--      automaticamente — a #516 e explicita: down e sempre manual. O condutor
--      o roda a mao na fase de recuperacao (ou roda o `DROP TABLE` direto, que
--      e a mesma linha).

DROP TABLE IF EXISTS drill_705_marcador;
