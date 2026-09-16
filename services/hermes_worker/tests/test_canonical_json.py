"""Paridade de digest com o TypeScript (spec §5.3.4, T08).

**De onde vieram as constantes deste arquivo.** Elas NÃO foram calculadas em
Python: foram geradas executando a implementação TypeScript de verdade, uma vez,
e fixadas aqui. O comando, a partir da raiz do repositório:

    node node_modules/tsx/dist/cli.mjs <script>

onde ``<script>`` importa ``src/integrations/hermes/canonical-json.js`` e imprime
``canonicalJsonStringify``/``canonicalDigest`` de cada valor abaixo. Rodado com
Node v22.23.2 contra ``src/integrations/hermes/canonical-json.ts``.

É isso que dá sentido ao teste: se alguém "melhorar" o encoder Python e ele
deixar de bater com o TS, o digest de identidade passa a divergir entre o
supervisor e o worker — e dois pedidos idênticos viram "mesma chave com bytes
diferentes", que a spec §5.6.1 classifica como conflito terminal. Recalcular
estes valores em Python para "consertar o teste" apagaria exatamente o sinal que
ele existe para dar.

Os casos foram escolhidos onde Python e JavaScript DISCORDAM por padrão:
formatação de número, inteiro acima de 2^53, ordem de chave com caractere
astral, surrogate solitário e caracteres de controle.

Nota de escrita: tanto os caracteres de controle quanto o texto de escape
esperado são montados com ``chr()`` e ``BARRA``, nunca escritos como literais de
escape. Um literal de escape neste arquivo produz o CARACTERE no fonte, e o que
o JSON de saída carrega é o TEXTO — os dois não são a mesma coisa, e é
justamente essa diferença que o teste verifica.
"""

from __future__ import annotations

import pytest

from hermes_worker.canonical_json import (
    CanonicalJsonError,
    canonical_byte_length,
    canonical_digest,
    canonical_json_stringify,
    utf16_length,
)

BARRA = chr(92)
EMOJI = chr(0x1F600)  # astral: dois code units UTF-16
REPLACEMENT = chr(0xFFFD)  # BMP alto
DEL = chr(0x7F)
SURROGATE = chr(0xD800)
SEPARADORES = chr(0x2028) + chr(0x2029)

#: Os nove controles de entrada, como CARACTERES.
CONTROLES = "".join(
    chr(c) for c in (0x01, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1F, 0x7F)
)
#: O mesmo conteúdo como TEXTO de escape, que é o que o JSON carrega. DEL fica
#: cru (nem o JS nem nós o escapamos).
ESCAPES_CONTROLES = (
    BARRA + "u0001"
    + BARRA + "b"
    + BARRA + "t"
    + BARRA + "n"
    + BARRA + "u000b"
    + BARRA + "f"
    + BARRA + "r"
    + BARRA + "u001f"
    + DEL
)

# (id, valor, canônico esperado, digest esperado) — todos vindos do TS.
CASOS_TS = [
    ("objeto_vazio", {}, "{}",
     "85d7c6e58c1d727a2afb12ec41758b72bb1034a687a0b515633becf76bccf8fa"),
    ("array_vazio", [], "[]",
     "ae1af8b1b3fc090b9fc82949533aed6a06bcb524c049ce92403c76675bad3827"),
    ("a_1", {"a": 1}, '{"a":1}',
     "a7324b0caeaf4c17b2ad34e40b1b550bebc2ba61846422086a34975361f048f5"),
    ("a_2", {"a": 2}, '{"a":2}',
     "30372287bb135cecb060cfb49b7e04c630413938622e3621529ea5dbefda0c18"),
    ("reorder_1", {"b": 1, "a": {"d": [1, 2, {"z": True, "y": None}], "c": "x"}},
     '{"a":{"c":"x","d":[1,2,{"y":null,"z":true}]},"b":1}',
     "fb3bd1d3a2601778c2cbd7bf3f1045530d1463203299e74efef6eeaa43802cb0"),
    ("reorder_2", {"a": {"c": "x", "d": [1, 2, {"y": None, "z": True}]}, "b": 1},
     '{"a":{"c":"x","d":[1,2,{"y":null,"z":true}]},"b":1}',
     "fb3bd1d3a2601778c2cbd7bf3f1045530d1463203299e74efef6eeaa43802cb0"),
    ("args_fixture", {"texto": "oi"}, '{"texto":"oi"}',
     "ae120466562bd2af9477613d2e8894341ac98e26c7c17d99371c31b52049912c"),
    ("string_nua", "texto", '"texto"',
     "1e7a80481282992289f1372e65b48a597114a747c890fc1f4c0b3f2e71a45f45"),
    ("nulo", None, "null",
     "5baed54ba6cb74a32822d27cf7f4c682fc981732db69ea5758c83da76996a0a6"),
    ("booleano", True, "true",
     "985133c3cc366c9bfdf8157361bcdd83980f92695e2b5e38510f5c51eecce2d5"),
    ("zero", 0, "0",
     "7936ef10bcb310909c245e65afa1ac70d0b1dc698114ebb59e5351443d975a08"),
    # `-0` e `0` são o mesmo valor lógico: mesmo digest, de propósito.
    ("zero_negativo", -0.0, "0",
     "7936ef10bcb310909c245e65afa1ac70d0b1dc698114ebb59e5351443d975a08"),
    ("float_meio", 1.5, "1.5",
     "f6ac4c21f611f20fd6a1e98aa449e0f7cb3a432cb8079e09f9c68ee75e9de4a3"),
    # Python diria "100.0"; o JS diz "100".
    ("float_int", 100.0, "100",
     "02ea1e060079e8442a64376d06235cd6166499fc0f4e58999b90751fe68b86dd"),
    ("e21", 1e21, "1e+21",
     "f421ad7e7dd48950cb4730163637b17780dc648ffcd3d763128e782917102cbf"),
    # Python diria "1e-07"; o JS diz "1e-7".
    ("e_menos_7", 1e-7, "1e-7",
     "405eee67f37b828347a70f95f1182dc1111b6469b58fa0e2d007d3623642c2ca"),
    # Python diria "1e+17"; o JS expande até 10^21.
    ("e17", 1e17, "100000000000000000",
     "009837e67c0385300e618cc281a2d8f1bfedf38c46d28ba416e1ccd8fb02ffb1"),
    ("ponto_um", 0.1, "0.1",
     "c307aacbbbaadd0e43189daa1830a0159a16ef979b30e6811a65ec7a60db8aa8"),
    ("negativo", -42, "-42",
     "1d1d283a0d4994fb255e3615509567e5bbd2afac4adba5ff8f6fbba1e51eccc2"),
    # int exato em Python, double no JS: quem manda é o JS.
    ("int_grande", 12345678901234567890, "12345678901234567000",
     "3c005f9c2fbbeabb9b0490393c782bf0a4f8336e7c246a6ae18e8af244870e82"),
    ("unicode", {"k": "ãé" + EMOJI}, '{"k":"ãé' + EMOJI + '"}',
     "b1a3f1c432bbb0b0c0ca2e583df72730fb13a60757481bad98aa0a82c0dabc9b"),
    ("controle", {"k": CONTROLES}, '{"k":"' + ESCAPES_CONTROLES + '"}',
     "f96ae6dc311485567b439dedb3f69f5638555f196bad0ed143407c6682e2bba3"),
    # `json.dumps` emitiria o surrogate cru e o encode UTF-8 estouraria.
    ("surrogate_solitario", {"k": SURROGATE},
     '{"k":"' + BARRA + 'ud800"}',
     "1db65219c42ca3e0295b666bac2aba9f5f28286e52ff707bb969eb303a396ab2"),
    # U+2028/2029 seguem CRUS nos dois lados.
    ("u2028", {"k": SEPARADORES}, '{"k":"' + SEPARADORES + '"}',
     "89ac3a204d4c7e2c9ee26d0d0a029f9dfa9695ac6dc622d8b804f5e3da84fffc"),
    ("aninhado_ordem", {"z": [{"b": 2, "a": 1}], "a": {"": 0, " ": 1, "A": 2, "a": 3}},
     '{"a":{"":0," ":1,"A":2,"a":3},"z":[{"a":1,"b":2}]}',
     "dc659a2da1dda84a6f57008e5f67892e2ffb6a70943f05ca5ad86258f244a499"),
    # ORDEM UTF-16: o emoji vem ANTES de U+FFFD. `sorted()` do Python inverteria.
    ("chaves_astrais", {REPLACEMENT: 1, EMOJI: 2, "z": 3, "Z": 4},
     '{"Z":4,"z":3,"' + EMOJI + '":2,"' + REPLACEMENT + '":1}',
     "f670ba124ea83bac4f4bb26c7d36ad2e654683640c2dc69023c3fb49aad868ad"),
    ("chave_astral_so", {EMOJI: 1, chr(0xFFFF): 2},
     '{"' + EMOJI + '":1,"' + chr(0xFFFF) + '":2}',
     "fa5b3d112f8f2704fc35c1995aec5ac8eb6a177c23bcdc45de689e8ab3fca716"),
    ("frame_tool_request", {
        "protocol": "maia.hermes.worker.v1", "type": "tool.request",
        "run_id": "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70", "call_seq": 0,
        "name": "maia_fixture_echo", "args": {"texto": "oi"},
        "observed_session_id": None,
    },
     '{"args":{"texto":"oi"},"call_seq":0,"name":"maia_fixture_echo",'
     '"observed_session_id":null,"protocol":"maia.hermes.worker.v1",'
     '"run_id":"3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70","type":"tool.request"}',
     "4e3c230cd48a2aae8ec1c2d48eebeebcc6089fe2d290a72419b43e1135150683"),
]


@pytest.mark.parametrize(
    "caso_id,valor,canonico,digest",
    CASOS_TS,
    ids=[caso[0] for caso in CASOS_TS],
)
def test_bate_byte_a_byte_com_o_typescript(caso_id, valor, canonico, digest) -> None:
    assert canonical_json_stringify(valor) == canonico
    assert canonical_digest(valor) == digest


def test_escapes_curtos_sao_texto_nao_caractere_de_controle() -> None:
    """A tabela de escapes carrega TEXTO: barra-invertida mais a letra.

    Se ela carregasse o caractere de controle, o JSON emitido teria um byte de
    controle cru dentro de uma string — inválido, e diferente do que o TS emite.
    """
    saida = canonical_json_stringify({"k": chr(0x08)})
    assert saida == '{"k":"' + BARRA + 'b"}'
    assert chr(0x08) not in saida


def test_reordenar_nao_muda_o_digest() -> None:
    a = {"b": 1, "a": {"d": [1, 2, {"z": True, "y": None}], "c": "x"}}
    b = {"a": {"c": "x", "d": [1, 2, {"y": None, "z": True}]}, "b": 1}
    assert canonical_json_stringify(a) == canonical_json_stringify(b)
    assert canonical_digest(a) == canonical_digest(b)


def test_conteudo_diferente_muda_o_digest() -> None:
    assert canonical_digest({"a": 1}) != canonical_digest({"a": 2})
    # Ordem de ARRAY é conteúdo, não apresentação.
    assert canonical_digest({"a": [1, 2]}) != canonical_digest({"a": [2, 1]})


def test_valores_fora_do_json_sao_erro_tipado() -> None:
    ciclo: dict[str, object] = {}
    ciclo["self"] = ciclo
    casos = [
        ({"a": float("nan")}, "non_finite"),
        ({"a": float("inf")}, "non_finite"),
        ({"a": object()}, "unsupported_type"),
        ({"a": (1, 2)}, "unsupported_type"),
        ({"a": {1, 2}}, "unsupported_type"),
        ({1: "chave int"}, "unsupported_type"),
        (ciclo, "cycle"),
    ]
    for valor, code in casos:
        with pytest.raises(CanonicalJsonError) as exc:
            canonical_json_stringify(valor)
        assert exc.value.code == code


def test_chave_proibida_recusada_em_qualquer_profundidade() -> None:
    for valor in (
        {"__proto__": {"a": 1}},
        {"ok": {"nested": {"constructor": 1}}},
        {"ok": [{"prototype": True}]},
    ):
        with pytest.raises(CanonicalJsonError) as exc:
            canonical_json_stringify(valor)
        assert exc.value.code == "forbidden_key"


def test_mensagem_de_erro_carrega_caminho_e_nao_valor() -> None:
    """O texto da exceção pode sair pelo dispatch do Hermes; leva caminho, não dado."""
    segredo = "SALDO-4815162342"

    class NaoSerializavel:
        def __repr__(self) -> str:  # pragma: no cover - não deve ser chamado
            return segredo

    with pytest.raises(CanonicalJsonError) as exc:
        canonical_json_stringify({"campo": NaoSerializavel()})
    mensagem = str(exc.value)
    assert "campo" in mensagem
    assert segredo not in mensagem


def test_byte_length_conta_utf8_da_forma_canonica() -> None:
    assert canonical_byte_length({"a": 1}) == len('{"a":1}')
    esperado = ('{"k":"' + EMOJI + '"}').encode("utf-8")
    assert canonical_byte_length({"k": EMOJI}) == len(esperado)


def test_utf16_length_conta_como_o_javascript() -> None:
    assert utf16_length("oi") == 2
    assert utf16_length(EMOJI) == 2  # par substituto
    assert utf16_length("ã") == 1
