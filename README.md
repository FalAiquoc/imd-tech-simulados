# IMD Tech Simulados

Plataforma de simulados e questionários para revisão de conteúdos do **IMD Tech**, com seleção por módulos e aulas, níveis de dificuldade, explicação das respostas e acompanhamento de desempenho.

## Como usar (2 formas simples)

### 1. Direto no navegador (sem instalar nada)
1. Baixe ou clone este repositório.
2. Abra o arquivo `imd_quest_plataforma_de_simulados_e_aprendizado_imd_ufrn_3.html` no seu navegador (Chrome, Edge, Firefox, etc.).
3. Seu progresso, histórico, ofensiva e estatísticas são salvos automaticamente no armazenamento local do navegador (**IndexedDB**).

### 2. Pelo inicializador no Windows (com banco SQLite local)
1. Dê um duplo clique em `Iniciar_IMD_Tech_Simulados.bat`.
2. Se você tiver **Python 3** instalado, o servidor local será iniciado e criará automaticamente o arquivo `simulados.db` na mesma pasta para salvar seu histórico.
3. Se você não tiver Python instalado, o inicializador abrirá a plataforma diretamente no navegador usando o armazenamento local (**IndexedDB**).

## Recursos principais
- Seleção granular por **módulo** e por **aula**.
- Questões classificadas por dificuldade (`Fácil`, `Médio`, `Difícil`) com explicação ao responder.
- Retomada automática de simulado em andamento.
- Painel de histórico com assertividade, ofensiva diária, tempo médio por questão, evolução temporal e pontos de reforço.
- Exportação e importação de backup em **JSON** e exportação de relatório em **CSV**.

## Privacidade
Todos os dados de estudo ficam salvos **apenas no seu próprio computador** (no navegador ou no arquivo local `simulados.db`, que já está no `.gitignore`). Nenhum dado pessoal é enviado para servidores externos.
