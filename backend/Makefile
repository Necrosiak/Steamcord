# This is the default target, which will be built when 
# you invoke make
# Taken from https://github.com/marissa999/decky-recorder
current_dir = $(shell pwd)
container_name = deckcord-backend
.PHONY: all
all:
	chmod +x $(current_dir)/entrypoint.sh
	mkdir -p $(current_dir)/out
	chmod 755 $(current_dir)/out
	docker build -t $(container_name) .
	docker run --rm -i -v $(current_dir):/backend -v $(current_dir)/out:/backend/out --entrypoint /backend/entrypoint.sh $(container_name)
rebuild:
	docker rmi $(container_name)
	docker build -t $(container_name) .
onlyrun:
	chmod +x $(current_dir)/entrypoint.sh	
	docker run --rm -i -v $(current_dir):/backend -v $(current_dir)/out:/backend/out --entrypoint /backend/entrypoint.sh $(container_name)