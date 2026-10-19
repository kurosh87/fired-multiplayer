	.text
	.globaltype __stack_pointer, i32
	.functype KantoGameFrame () -> ()
	.section .text.KantoRunGameStack,"",@
	.globl KantoRunGameStack
	.type KantoRunGameStack,@function
KantoRunGameStack:
	.functype KantoRunGameStack (i32) -> ()
	.local i32
	global.get __stack_pointer
	local.set 1
	local.get 0
	i32.load 0
	global.set __stack_pointer
	call KantoGameFrame
	local.get 0
	global.get __stack_pointer
	i32.store 0
	local.get 1
	global.set __stack_pointer
	end_function
