'use strict';

/**
 * Quando o Windows pode fechar a janela do Player (botão da barra de tarefas, Alt+F4, "Fechar janela").
 * Em tela cheia (a TV em operação) fechar fica bloqueado: só a manutenção encerra. Em janela comum ou
 * minimizado, o usuário já abriu a manutenção de propósito, então fechar pela barra de tarefas vale.
 */
function canClose({ windowed = false, quitting = false, winMode = 'full', minimized = false } = {}) {
  if (windowed || quitting) return true;
  return winMode === 'window' || minimized;
}

module.exports = { canClose };
