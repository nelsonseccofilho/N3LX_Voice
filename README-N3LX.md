# N3LX_Voice

Evolução pessoal do [VoiceStudio](https://github.com/debpalash/VoiceStudio), baseada na versão 0.5.7. O histórico e os créditos do projeto original foram preservados. A licença original permanece em `LICENSE`.

## O que foi incorporado

- Clonagem e síntese com referência de voz em português do Brasil.
- VoxCPM2 nativo com Vulkan na AMD Radeon RX 6600M e seleção explícita de CPU.
- Separação entre fala e canto, com modelo e voz de destino obrigatórios e seleção visível.
- Seed-VC SVC para canto, mantendo melodia/ritmo; DirectML com etapas de CPU ou execução integral em CPU.
- Progresso real: etapa, trecho atual/total, passos concluídos/total, tempo decorrido e previsão apenas quando mensurável.
- Cancelamento de processo próprio e limite de 30 minutos sem avanço, permitindo músicas longas enquanto há progresso.
- Escolha de CPU/GPU e de destino antes da conversão, nome sugerido `_convert.wav`, salvamento automático e acesso à pasta.
- Correções de interface, mensagens e exibição do dispositivo AMD quando não há telemetria disponível.

## Instalação e reconstrução

Os fontes externos e seus commits estão fixados em `n3lx-sources.json`. As instruções detalhadas ficam em [VoxCPM2](docs/engines/voxcpm2.md), [Seed-VC](docs/engines/seed-vc.md) e [ferramentas Electron](docs/electron-tools.md). Os pesos devem ser obtidos separadamente pelo fluxo documentado; eles não estão neste Git.

1. Clone `llama.cpp-omni` e `seed-vc` como pastas irmãs deste repositório e selecione os commits do manifesto.
2. Aplique o patch em `patches/llama.cpp-omni/` ao checkout nativo com `git apply --check` e depois `git apply`; compile o servidor com Vulkan conforme a documentação do motor.
3. Prepare os ambientes Python e pesos seguindo as instruções de cada motor. DirectML exige validação local explícita da GPU; o registro é específico de cada máquina e não é distribuído.
4. Instale as dependências do aplicativo e compile a interface conforme o [README original](README.md).
5. Os launchers Windows ficam em `scripts/n3lx/`. O principal usa canto híbrido, Vulkan para fala e limite de seis threads de CPU nas próximas aberturas. O launcher de CPU é a alternativa para canto sem DirectML. Confira os caminhos/ambientes antes de iniciar.

## Estado da instalação atual

A instalação em uso permanece no checkout original; criar esta cópia não reinicia nem interrompe conversões. Um clone novo cria seu próprio diretório `.local-data`: os perfis e gravações pessoais não são transferidos automaticamente.

Este Git preserva o código e as instruções. Áudios próprios, perfis de voz, bancos de dados, pesos de modelos, ambientes instalados e executáveis ficam fora do backup online e precisam de backup privado separado.

## Validação registrada

Na instalação local, 56 testes de backend e 53 testes de interface/exportação passaram, assim como a compilação Electron e a verificação dos 21 idiomas. Um teste real de canto de seis segundos na RX 6600M concluiu em 4min01s e salvou uma cópia idêntica à saída interna. A qualidade de timbre exige avaliação auditiva. A validação não constitui teste completo em todas as plataformas nem benchmark de música inteira.

O aumento para seis threads foi preparado depois desse teste e ainda precisa de comparação de desempenho. Os detalhes e limites do caminho híbrido estão na documentação do Seed-VC.

## Identidade do aplicativo

A interface e o aplicativo nativo usam `N3LX_Voice`. Atalhos Pro, página de compra e promoções comerciais foram removidos; o endereço legado `/pro` redireciona ao suporte do projeto. Dar estrela abre este repositório sem executar a ação automaticamente. Como o repositório é privado, não há consulta pública nem contador de estrelas herdado. Os créditos e a licença do VoiceStudio original permanecem disponíveis.

O nome interno do diretório de preferências Electron foi mantido para preservar configurações e sessões existentes. Os endereços de atualização do fork apontam ao próprio N3LX_Voice; uma instalação clonada não deve baixar uma atualização do projeto original sobre as alterações locais. Isso não cria publicações ou instaladores automaticamente.

Os launchers respeitam `OMNIVOICE_DATA_DIR` quando definido. Na instalação existente, reutilizam o banco `.local-data` do checkout irmão `VoiceStudio` quando ele está presente, preservando perfis e tomadas. Um ambiente novo continua com dados locais próprios. O diretório de preferências Electron também permanece no endereço legado para evitar perda de configurações.
