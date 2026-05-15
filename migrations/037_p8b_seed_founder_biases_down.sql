-- Reverte seed 037: remove os 3 founder biases.
DELETE FROM soul_biases
  WHERE proposed_by = 'founder'
    AND tenant_id = 'default'
    AND principle IN ('humildade_epistemica', 'presenca_antes_de_fato', 'pergunta_antes_de_recomendacao');
